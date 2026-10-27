import * as cdk from 'aws-cdk-lib';
import { lookupPlatformNetwork } from '../src/constructs/platform-network';

describe('lookupPlatformNetwork', () => {
  it('finds the VPC by the platform tag and the security group by name, in the stack\'s account and region', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'Consumer', { env: { account: '443370708724', region: 'eu-west-1' } });
    lookupPlatformNetwork(stack);

    const missing = app.synth().manifest.missing ?? [];
    const vpc = missing.find((m) => m.provider === 'vpc-provider')!;
    expect(vpc.props).toMatchObject({
      account: '443370708724',
      region: 'eu-west-1',
      filter: { 'tag:gnome:network': 'platform' },
    });
    const group = missing.find((m) => m.provider === 'security-group')!;
    expect(group.props).toMatchObject({ securityGroupName: 'gnome-platform-sg', region: 'eu-west-1' });
  });
});
