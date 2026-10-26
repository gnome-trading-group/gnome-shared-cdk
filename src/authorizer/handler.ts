import { createPublicKey, JsonWebKey, KeyObject, timingSafeEqual, verify } from 'crypto';
import { APIGatewayClient, GetApiKeyCommand } from '@aws-sdk/client-api-gateway';
import { BOT_READ_SCOPE, BOT_RESOURCE_SERVER, BOT_WRITE_SCOPE, CallerKind } from './kinds';

export interface AuthorizerEvent {
  methodArn: string;
  httpMethod: string;
  headers?: { [name: string]: string | undefined } | null;
}

export interface AuthorizerResult {
  principalId: string;
  policyDocument: {
    Version: string;
    Statement: { Action: string; Effect: 'Allow' | 'Deny'; Resource: string }[];
  };
  context: { [key: string]: string };
}

export interface AuthorizerDeps {
  allowedKinds: Set<string>;
  issuer: string;
  fetchSigningKeys: () => Promise<JsonWebKey[]>;
  fetchApiKeys: () => Promise<string[]>;
  now: () => number;
}

interface Caller {
  kind: CallerKind;
  actor: string;
  email?: string;
  clientId?: string;
  scopes?: string[];
}

const API_KEY_REFRESH_MS = 5 * 60 * 1000;
// An unknown kid usually means Cognito rotated its keys; the bound stops a stream of forged tokens from turning into
// a stream of JWKS fetches.
const SIGNING_KEY_REFETCH_MS = 60 * 1000;
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// Lambda maps exactly this message to a 401; anything else thrown becomes a 500.
class Unauthorized extends Error {
  constructor() {
    super('Unauthorized');
  }
}

export class Authorizer {
  private signingKeys = new Map<string, KeyObject>();
  private signingKeysFetchedAt = 0;
  private apiKeys: Buffer[] = [];
  private apiKeysFetchedAt = 0;

  constructor(private readonly deps: AuthorizerDeps) {}

  async authorize(event: AuthorizerEvent): Promise<AuthorizerResult> {
    const caller = await this.identify(event);
    const allowed = this.deps.allowedKinds.has(caller.kind) && this.scopeAllows(caller, event.httpMethod);
    const context: { [key: string]: string } = { kind: caller.kind, actor: caller.actor };
    if (caller.email) context.email = caller.email;
    if (caller.clientId) context.clientId = caller.clientId;
    return {
      principalId: caller.actor,
      policyDocument: {
        Version: '2012-10-17',
        Statement: [{ Action: 'execute-api:Invoke', Effect: allowed ? 'Allow' : 'Deny', Resource: event.methodArn }],
      },
      context,
    };
  }

  private async identify(event: AuthorizerEvent): Promise<Caller> {
    const headers = lowerCaseKeys(event.headers);
    const authorization = headers['authorization'];
    if (authorization) {
      return this.identifyToken(authorization.replace(/^Bearer\s+/i, ''));
    }
    const apiKey = headers['x-api-key'];
    if (apiKey && await this.isKnownApiKey(apiKey)) {
      return { kind: CallerKind.SERVICE, actor: CallerKind.SERVICE };
    }
    throw new Unauthorized();
  }

  private async identifyToken(token: string): Promise<Caller> {
    const claims = await this.verifyJwt(token);
    if (claims.token_use === 'id' && typeof claims.email === 'string') {
      return { kind: CallerKind.PERSON, actor: claims.email, email: claims.email };
    }
    if (claims.token_use === 'access' && typeof claims.client_id === 'string') {
      const scopes = typeof claims.scope === 'string' ? claims.scope.split(' ') : [];
      // A person's access token carries only openid/email/profile; only a client granted a gnome-api scope is a bot.
      if (scopes.some((s) => s.startsWith(`${BOT_RESOURCE_SERVER}/`))) {
        return { kind: CallerKind.BOT, actor: `bot:${claims.client_id}`, clientId: claims.client_id, scopes };
      }
    }
    throw new Unauthorized();
  }

  private scopeAllows(caller: Caller, httpMethod: string): boolean {
    if (caller.kind !== CallerKind.BOT) return true;
    const needed = READ_METHODS.has(httpMethod.toUpperCase()) ? BOT_READ_SCOPE : BOT_WRITE_SCOPE;
    return caller.scopes?.includes(`${BOT_RESOURCE_SERVER}/${needed}`) ?? false;
  }

  private async verifyJwt(token: string): Promise<{ [claim: string]: unknown }> {
    const parts = token.split('.');
    if (parts.length !== 3) throw new Unauthorized();
    let header: { alg?: unknown; kid?: unknown };
    let claims: { [claim: string]: unknown };
    try {
      header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
      claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    } catch {
      throw new Unauthorized();
    }
    if (header.alg !== 'RS256' || typeof header.kid !== 'string') throw new Unauthorized();
    const key = await this.signingKey(header.kid);
    const signed = Buffer.from(`${parts[0]}.${parts[1]}`);
    if (!key || !verify('RSA-SHA256', signed, key, Buffer.from(parts[2], 'base64url'))) throw new Unauthorized();
    if (claims.iss !== this.deps.issuer) throw new Unauthorized();
    if (typeof claims.exp !== 'number' || claims.exp * 1000 <= this.deps.now()) throw new Unauthorized();
    return claims;
  }

  private async signingKey(kid: string): Promise<KeyObject | undefined> {
    const known = this.signingKeys.get(kid);
    if (known || this.deps.now() - this.signingKeysFetchedAt < SIGNING_KEY_REFETCH_MS) return known;
    const keys = await this.deps.fetchSigningKeys();
    this.signingKeys = new Map(
      keys.filter((k) => typeof k.kid === 'string').map((k) => [k.kid as string, createPublicKey({ key: k, format: 'jwk' })]),
    );
    this.signingKeysFetchedAt = this.deps.now();
    return this.signingKeys.get(kid);
  }

  private async isKnownApiKey(presented: string): Promise<boolean> {
    if (this.deps.now() - this.apiKeysFetchedAt >= API_KEY_REFRESH_MS) {
      this.apiKeys = (await this.deps.fetchApiKeys()).map((k) => Buffer.from(k));
      this.apiKeysFetchedAt = this.deps.now();
    }
    const candidate = Buffer.from(presented);
    return this.apiKeys.some((k) => k.length === candidate.length && timingSafeEqual(k, candidate));
  }
}

function lowerCaseKeys(headers: AuthorizerEvent['headers']): { [name: string]: string | undefined } {
  const out: { [name: string]: string | undefined } = {};
  for (const [name, value] of Object.entries(headers ?? {})) out[name.toLowerCase()] = value;
  return out;
}

function authorizerFromEnv(): Authorizer {
  const region = process.env.AWS_REGION;
  const issuer = `https://cognito-idp.${region}.amazonaws.com/${process.env.USER_POOL_ID}`;
  const apiKeyIds = (process.env.API_KEY_IDS ?? '').split(',').filter(Boolean);
  const apigateway = new APIGatewayClient({ region });
  return new Authorizer({
    allowedKinds: new Set((process.env.ALLOWED_KINDS ?? '').split(',').filter(Boolean)),
    issuer,
    fetchSigningKeys: async () => {
      const response = await fetch(`${issuer}/.well-known/jwks.json`);
      if (!response.ok) throw new Error(`JWKS fetch failed: ${response.status}`);
      return ((await response.json()) as { keys: JsonWebKey[] }).keys;
    },
    fetchApiKeys: async () => {
      const keys = await Promise.all(apiKeyIds.map((id) => apigateway.send(new GetApiKeyCommand({ apiKey: id, includeValue: true }))));
      return keys.filter((k) => k.enabled && k.value).map((k) => k.value as string);
    },
    now: () => Date.now(),
  });
}

let instance: Authorizer | undefined;

export async function handler(event: AuthorizerEvent): Promise<AuthorizerResult> {
  instance ??= authorizerFromEnv();
  return instance.authorize(event);
}
