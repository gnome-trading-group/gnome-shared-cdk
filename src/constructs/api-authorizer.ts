import * as cdk from 'aws-cdk-lib';
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as path from 'path';
import { Construct } from 'constructs';
import { CallerKind } from '../authorizer/kinds';

export interface GnomeApiAuthorizerProps {
  /** Pool whose ID tokens identify people and whose gnome-api-scoped access tokens identify bots. */
  userPool: cognito.IUserPool;
  /** Keys services send as x-api-key; omit for an API no service calls. */
  apiKeys?: apigw.IApiKey[];
}

/** HTTP method → the caller kinds allowed to call it. */
export type RouteMethods = { [httpMethod: string]: CallerKind[] };

/**
 * One authorizer for every caller of an API: services by API key, people by Cognito ID token, bots by Cognito access
 * token. Each route names the caller kinds it allows, and every other caller gets a 403.
 */
export class GnomeApiAuthorizer extends Construct {
  private readonly props: GnomeApiAuthorizerProps;
  private readonly role: iam.Role;
  private readonly authorizers = new Map<string, apigw.RequestAuthorizer>();

  constructor(scope: Construct, id: string, props: GnomeApiAuthorizerProps) {
    super(scope, id);
    this.props = props;

    this.role = new iam.Role(this, 'Role', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')],
    });
    if (props.apiKeys?.length) {
      this.role.addToPolicy(new iam.PolicyStatement({
        actions: ['apigateway:GET'],
        resources: props.apiKeys.map((k) => k.keyArn),
      }));
    }
  }

  addRoute(root: apigw.IResource, routePath: string, integration: apigw.Integration, methods: RouteMethods): void {
    const resource = root.resourceForPath(routePath);
    for (const [httpMethod, kinds] of Object.entries(methods)) {
      resource.addMethod(httpMethod, integration, {
        authorizationType: apigw.AuthorizationType.CUSTOM,
        authorizer: this.authorizerFor(kinds),
      });
    }
  }

  // A REQUEST authorizer can't be told which method invoked it, so each distinct set of allowed kinds gets its own
  // function (same code, different ALLOWED_KINDS) instead of one function holding a route table.
  authorizerFor(kinds: CallerKind[]): apigw.IAuthorizer {
    if (kinds.length === 0) {
      throw new Error('A route must allow at least one caller kind');
    }
    const key = [...new Set(kinds)].sort().join('-');
    const existing = this.authorizers.get(key);
    if (existing) return existing;

    const apiKeyIds = (this.props.apiKeys ?? []).map((k) => k.keyId);
    const fn = new lambda.Function(this, `Fn-${key}`, {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'handler.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', 'authorizer')),
      role: this.role,
      memorySize: 256,
      timeout: cdk.Duration.seconds(10),
      environment: {
        ALLOWED_KINDS: key.split('-').join(','),
        USER_POOL_ID: this.props.userPool.userPoolId,
        API_KEY_IDS: apiKeyIds.length ? cdk.Fn.join(',', apiKeyIds) : '',
      },
    });
    // Caching is off: a cached REQUEST authorizer needs every identity source present on each request, and callers
    // send either Authorization or x-api-key, never both.
    const authorizer = new apigw.RequestAuthorizer(this, `Authorizer-${key}`, {
      handler: fn,
      identitySources: [],
      resultsCacheTtl: cdk.Duration.seconds(0),
    });
    this.authorizers.set(key, authorizer);
    return authorizer;
  }
}
