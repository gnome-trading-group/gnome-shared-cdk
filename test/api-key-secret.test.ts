import * as cdk from 'aws-cdk-lib';
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { API_KEY_SECRET_NAMES, ApiKeySecret } from '../src';
import { MirrorDeps, MirrorEvent, mirrorApiKey } from '../src/api-key-secret/handler';

describe('ApiKeySecret', () => {
  const stack = new cdk.Stack();
  const apiKey = new apigw.ApiKey(stack, 'Key');
  new ApiKeySecret(stack, 'Mirror', { apiKey, secretName: API_KEY_SECRET_NAMES.REGISTRY });
  const template = Template.fromStack(stack);

  it('creates the secret under its fixed name with only a placeholder value', () => {
    template.hasResourceProperties('AWS::SecretsManager::Secret', {
      Name: 'gnome/api-keys/registry',
      SecretString: 'pending',
    });
  });

  it('passes the key id and secret to the mirror, never the key value', () => {
    const [mirror] = Object.values(template.findResources('AWS::CloudFormation::CustomResource'));
    expect(Object.keys(mirror.Properties).sort()).toEqual(['ApiKeyId', 'SecretId', 'ServiceToken']);
  });

  it('lets the mirror read only its key and write only its secret', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({ Action: 'apigateway:GET', Effect: 'Allow' }),
          Match.objectLike({ Action: 'secretsmanager:PutSecretValue', Effect: 'Allow' }),
        ]),
      },
    });
  });
});

describe('mirrorApiKey', () => {
  const event = (RequestType: MirrorEvent['RequestType']): MirrorEvent => ({
    RequestType,
    ResourceProperties: { ApiKeyId: 'abc123', SecretId: 'arn:secret' },
  });
  const deps = (value: string | undefined): MirrorDeps => ({
    getApiKeyValue: jest.fn(async () => value),
    putSecretValue: jest.fn(async () => undefined),
  });

  it.each(['Create', 'Update'] as const)('copies the key value into the secret on %s', async (type) => {
    const d = deps('the-key');
    const result = await mirrorApiKey(event(type), d);
    expect(d.getApiKeyValue).toHaveBeenCalledWith('abc123');
    expect(d.putSecretValue).toHaveBeenCalledWith('arn:secret', 'the-key');
    expect(result).toEqual({ PhysicalResourceId: 'arn:secret' });
  });

  it('leaves the secret to CloudFormation on Delete', async () => {
    const d = deps('the-key');
    await mirrorApiKey(event('Delete'), d);
    expect(d.getApiKeyValue).not.toHaveBeenCalled();
    expect(d.putSecretValue).not.toHaveBeenCalled();
  });

  it('fails the deploy rather than write an empty secret', async () => {
    const d = deps(undefined);
    await expect(mirrorApiKey(event('Create'), d)).rejects.toThrow('API key abc123 has no value');
    expect(d.putSecretValue).not.toHaveBeenCalled();
  });
});
