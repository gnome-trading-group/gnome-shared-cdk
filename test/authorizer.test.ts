import { generateKeyPairSync, JsonWebKey, KeyObject, sign } from 'crypto';
import { Authorizer, AuthorizerDeps, AuthorizerEvent } from '../src/authorizer/handler';
import { CallerKind } from '../src/authorizer/kinds';

const ISSUER = 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_test';
const METHOD_ARN = 'arn:aws:execute-api:us-east-1:123456789012:abc/api/GET/pnl/summary';
const NOW = 1_800_000_000_000;

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const other = generateKeyPairSync('rsa', { modulusLength: 2048 });

function jwk(key: KeyObject, kid: string): JsonWebKey {
  return { ...key.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' };
}

function token(claims: object, opts: { kid?: string; key?: KeyObject } = {}): string {
  const encode = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const signed = `${encode({ alg: 'RS256', kid: opts.kid ?? 'k1' })}.${encode(claims)}`;
  return `${signed}.${sign('RSA-SHA256', Buffer.from(signed), opts.key ?? privateKey).toString('base64url')}`;
}

const exp = NOW / 1000 + 3600;
const idToken = (overrides: object = {}) => token({ iss: ISSUER, exp, token_use: 'id', email: 'op@gnometrading.group', ...overrides });
const botToken = (scope: string, overrides: object = {}) => token({ iss: ISSUER, exp, token_use: 'access', client_id: 'botclient', scope, ...overrides });

function authorizer(kinds: CallerKind[], overrides: Partial<AuthorizerDeps> = {}) {
  const deps: AuthorizerDeps = {
    allowedKinds: new Set(kinds),
    issuer: ISSUER,
    fetchSigningKeys: jest.fn(async () => [jwk(publicKey, 'k1')]),
    fetchApiKeys: jest.fn(async () => ['service-key']),
    now: () => NOW,
    ...overrides,
  };
  return { authorizer: new Authorizer(deps), deps };
}

const event = (headers: { [name: string]: string }, httpMethod = 'GET'): AuthorizerEvent => ({ methodArn: METHOD_ARN, httpMethod, headers });
const effect = (result: { policyDocument: { Statement: { Effect: string }[] } }) => result.policyDocument.Statement[0].Effect;

describe('Authorizer', () => {
  const all = [CallerKind.SERVICE, CallerKind.PERSON, CallerKind.BOT];

  it('identifies a person by ID token, raw or Bearer', async () => {
    const { authorizer: a } = authorizer(all);
    for (const value of [idToken(), `Bearer ${idToken()}`]) {
      const result = await a.authorize(event({ Authorization: value }));
      expect(effect(result)).toBe('Allow');
      expect(result.context).toEqual({ kind: 'person', actor: 'op@gnometrading.group', email: 'op@gnometrading.group' });
      expect(result.policyDocument.Statement[0].Resource).toBe(METHOD_ARN);
    }
  });

  it('identifies a service by API key', async () => {
    const result = await authorizer(all).authorizer.authorize(event({ 'X-Api-Key': 'service-key' }));
    expect(effect(result)).toBe('Allow');
    expect(result.context).toEqual({ kind: 'service', actor: 'service' });
  });

  it('identifies a bot by gnome-api scoped access token', async () => {
    const result = await authorizer(all).authorizer.authorize(event({ authorization: botToken('gnome-api/bot.read') }));
    expect(effect(result)).toBe('Allow');
    expect(result.context).toEqual({ kind: 'bot', actor: 'bot:botclient', clientId: 'botclient' });
  });

  it('denies a kind the route does not allow', async () => {
    const { authorizer: a } = authorizer([CallerKind.PERSON]);
    expect(effect(await a.authorize(event({ 'x-api-key': 'service-key' })))).toBe('Deny');
    expect(effect(await a.authorize(event({ authorization: botToken('gnome-api/bot.read') })))).toBe('Deny');
    expect(effect(await a.authorize(event({ authorization: idToken() })))).toBe('Allow');
  });

  it('needs bot.write for a bot to call anything but a read', async () => {
    const { authorizer: a } = authorizer(all);
    expect(effect(await a.authorize(event({ authorization: botToken('gnome-api/bot.read') }, 'POST')))).toBe('Deny');
    expect(effect(await a.authorize(event({ authorization: botToken('gnome-api/bot.read gnome-api/bot.write') }, 'POST')))).toBe('Allow');
  });

  it('prefers the token when a caller sends both', async () => {
    const result = await authorizer(all).authorizer.authorize(event({ authorization: idToken(), 'x-api-key': 'service-key' }));
    expect(result.context.kind).toBe('person');
  });

  it.each([
    ['no credentials', {}],
    ['an unknown API key', { 'x-api-key': 'nope' }],
    ['a token signed by another key', { authorization: token({ iss: ISSUER, exp, token_use: 'id', email: 'x@y' }, { key: other.privateKey }) }],
    ['a token from another pool', { authorization: idToken({ iss: 'https://cognito-idp.us-east-1.amazonaws.com/other' }) }],
    ['an expired token', { authorization: idToken({ exp: NOW / 1000 - 1 }) }],
    ['an ID token without email', { authorization: idToken({ email: undefined }) }],
    ['a person access token (no gnome-api scope)', { authorization: botToken('openid email profile') }],
    ['a garbage token', { authorization: 'not.a.jwt' }],
    ['an unsigned token', { authorization: idToken().split('.').slice(0, 2).join('.') + '.' }],
  ])('rejects %s with 401', async (_name, headers) => {
    await expect(authorizer(all).authorizer.authorize(event(headers as { [name: string]: string }))).rejects.toThrow(/^Unauthorized$/);
  });

  it('rejects a token whose header names another algorithm', async () => {
    const encode = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const forged = `${encode({ alg: 'none', kid: 'k1' })}.${encode({ iss: ISSUER, exp, token_use: 'id', email: 'x@y' })}.`;
    await expect(authorizer(all).authorizer.authorize(event({ authorization: forged }))).rejects.toThrow('Unauthorized');
  });

  it('refetches signing keys for a new kid, at most once a minute', async () => {
    let clock = NOW;
    const keys = [jwk(publicKey, 'k1')];
    const fetchSigningKeys = jest.fn(async () => keys);
    const { authorizer: a } = authorizer(all, { fetchSigningKeys, now: () => clock });
    await a.authorize(event({ authorization: idToken() }));
    keys.push(jwk(other.publicKey, 'k2'));
    const rotated = token({ iss: ISSUER, exp, token_use: 'id', email: 'op@gnometrading.group' }, { kid: 'k2', key: other.privateKey });
    await expect(a.authorize(event({ authorization: rotated }))).rejects.toThrow('Unauthorized');
    clock += 61_000;
    expect(effect(await a.authorize(event({ authorization: rotated })))).toBe('Allow');
    expect(fetchSigningKeys).toHaveBeenCalledTimes(2);
  });

  it('caches API keys and picks up a rotated key after the refresh interval', async () => {
    let clock = NOW;
    let current = ['old-key'];
    const fetchApiKeys = jest.fn(async () => current);
    const { authorizer: a } = authorizer(all, { fetchApiKeys, now: () => clock });
    expect(effect(await a.authorize(event({ 'x-api-key': 'old-key' })))).toBe('Allow');
    current = ['new-key'];
    await expect(a.authorize(event({ 'x-api-key': 'new-key' }))).rejects.toThrow('Unauthorized');
    clock += 5 * 60 * 1000;
    expect(effect(await a.authorize(event({ 'x-api-key': 'new-key' })))).toBe('Allow');
    expect(fetchApiKeys).toHaveBeenCalledTimes(2);
  });
});
