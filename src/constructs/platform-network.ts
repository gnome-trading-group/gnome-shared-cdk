import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';
import { PLATFORM_NETWORK_TAG, PLATFORM_SECURITY_GROUP_NAME } from '../regions';

export interface PlatformNetwork {
  vpc: ec2.IVpc;
  securityGroup: ec2.ISecurityGroup;
}

/**
 * The platform network (gnome-shared-infra) in the scope's stack's region, found by its tag and its security group's
 * name. A synth-time lookup: the stack needs an explicit account and region, and the result is cached in the app's
 * cdk.context.json, which must be regenerated whenever the network is recreated.
 */
export function lookupPlatformNetwork(scope: Construct): PlatformNetwork {
  const vpc = ec2.Vpc.fromLookup(scope, 'PlatformVpc', {
    tags: { [PLATFORM_NETWORK_TAG.key]: PLATFORM_NETWORK_TAG.value },
  });
  const securityGroup = ec2.SecurityGroup.fromLookupByName(
    scope, 'PlatformSecurityGroup', PLATFORM_SECURITY_GROUP_NAME, vpc);
  return { vpc, securityGroup };
}
