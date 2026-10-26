import * as cdk from 'aws-cdk-lib';
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { CallerKind, GnomeApiAuthorizer } from '../src';

function build() {
  const stack = new cdk.Stack();
  const api = new apigw.RestApi(stack, 'Api');
  const apiKey = new apigw.ApiKey(stack, 'Key');
  const userPool = cognito.UserPool.fromUserPoolArn(stack, 'Pool', 'arn:aws:cognito-idp:us-east-1:123456789012:userpool/us-east-1_test');
  const auth = new GnomeApiAuthorizer(stack, 'Auth', { userPool, apiKeys: [apiKey] });
  const integration = new apigw.MockIntegration();
  auth.addRoute(api.root, 'pnl/summary', integration, { GET: [CallerKind.PERSON, CallerKind.BOT] });
  auth.addRoute(api.root, 'ledger/batch', integration, { POST: [CallerKind.SERVICE] });
  auth.addRoute(api.root, 'strategy-sessions/stop', integration, { POST: [CallerKind.SERVICE, CallerKind.PERSON] });
  auth.addRoute(api.root, 'ledger/adjustments', integration, { GET: [CallerKind.BOT, CallerKind.PERSON], POST: [CallerKind.PERSON] });
  return Template.fromStack(stack);
}

describe('GnomeApiAuthorizer', () => {
  const template = build();

  it('creates one function and authorizer per distinct set of kinds', () => {
    const functions = template.findResources('AWS::Lambda::Function');
    const kinds = Object.values(functions).map((f) => f.Properties.Environment.Variables.ALLOWED_KINDS).sort();
    expect(kinds).toEqual(['bot,person', 'person', 'person,service', 'service']);
    template.resourceCountIs('AWS::ApiGateway::Authorizer', 4);
  });

  it('never caches authorization, so no identity source is required', () => {
    template.allResourcesProperties('AWS::ApiGateway::Authorizer', {
      Type: 'REQUEST',
      AuthorizerResultTtlInSeconds: 0,
      IdentitySource: '',
    });
  });

  it('puts every method behind the custom authorizer without an API key requirement', () => {
    const methods = template.findResources('AWS::ApiGateway::Method');
    expect(Object.keys(methods)).toHaveLength(5);
    for (const method of Object.values(methods)) {
      expect(method.Properties.AuthorizationType).toBe('CUSTOM');
      expect(method.Properties.ApiKeyRequired).toBeUndefined();
    }
  });

  it('lets the functions read only the given API keys', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: [Match.objectLike({ Action: 'apigateway:GET', Effect: 'Allow' })],
      },
    });
  });

  it('works for an API no service calls', () => {
    const stack = new cdk.Stack();
    const api = new apigw.RestApi(stack, 'Api');
    const userPool = cognito.UserPool.fromUserPoolArn(stack, 'Pool', 'arn:aws:cognito-idp:us-east-1:123456789012:userpool/us-east-1_test');
    new GnomeApiAuthorizer(stack, 'Auth', { userPool }).addRoute(api.root, 'x', new apigw.MockIntegration(), { GET: [CallerKind.PERSON] });
    const t = Template.fromStack(stack);
    t.hasResourceProperties('AWS::Lambda::Function', { Environment: { Variables: Match.objectLike({ API_KEY_IDS: '' }) } });
    t.resourceCountIs('AWS::IAM::Policy', 0);
  });

  it('refuses a route that allows nobody', () => {
    const stack = new cdk.Stack();
    const api = new apigw.RestApi(stack, 'Api');
    const userPool = cognito.UserPool.fromUserPoolArn(stack, 'Pool', 'arn:aws:cognito-idp:us-east-1:123456789012:userpool/us-east-1_test');
    const auth = new GnomeApiAuthorizer(stack, 'Auth', { userPool });
    expect(() => auth.addRoute(api.root, 'x', new apigw.MockIntegration(), { GET: [] })).toThrow(/at least one caller kind/);
  });
});
