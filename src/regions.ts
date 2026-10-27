// The platform network's regions and addressing, shared by every CDK app and by Lambdas, which import this file
// directly ('@gnome-trading-group/gnome-shared-cdk/dist/regions'): it must import nothing, CDK least of all.

/** Every region the platform runs in, by its index in the address plan. Adding a region is one entry here. */
export const PLATFORM_REGIONS: Readonly<Record<string, number>> = Object.freeze({
  'us-east-1': 0,
  'ap-northeast-1': 1,
  'eu-west-1': 2,
});

/** Where an account's single-region services live (the registry, storage, pipelines). */
export const PRIMARY_REGION = 'us-east-1';

/** The platform's regions in index order. */
export function platformRegions(): string[] {
  return Object.entries(PLATFORM_REGIONS).sort(([, a], [, b]) => a - b).map(([region]) => region);
}

/** Every region but the primary, e.g. where Secrets Manager replicates a secret. */
export function replicaRegions(): string[] {
  return platformRegions().filter((region) => region !== PRIMARY_REGION);
}

// Each account's /12, so dev and prod never overlap and could be joined later. 172.16.0.0/22 is kept free for a VPN.
const ACCOUNT_BLOCKS: Readonly<Record<string, string>> = Object.freeze({
  prod: '10.128.0.0',
  dev: '10.144.0.0',
});
const MAX_REGIONS = 16;

function octets(ip: string): number[] {
  return ip.split('.').map(Number);
}

/** A region's /16 within its account's /12: the account block plus the region's index in the second octet. */
export function platformCidr(stage: string, region: string): string {
  const block = ACCOUNT_BLOCKS[stage];
  if (block === undefined) throw new Error(`No platform network for stage ${stage}`);
  const index = PLATFORM_REGIONS[region];
  if (index === undefined) throw new Error(`${region} is not a platform region`);
  if (index >= MAX_REGIONS) throw new Error(`An account's /12 holds ${MAX_REGIONS} regions`);
  const [a, b] = octets(block);
  return `${a}.${b + index}.0.0/16`;
}

/** Every region's /16 for an account: what the platform security group admits Aeron from, across peering. */
export function allPlatformCidrs(stage: string): string[] {
  return platformRegions().map((region) => platformCidr(stage, region));
}

/** The public subnet for an availability zone: a /20 per zone from the bottom of the region's /16. */
export function publicSubnetCidr(stage: string, region: string, zoneIndex: number): string {
  if (zoneIndex < 0 || zoneIndex >= PUBLIC_SUBNET_ZONES_MAX) {
    throw new Error(`Public subnets fill the lower /17: at most ${PUBLIC_SUBNET_ZONES_MAX} zones`);
  }
  const [a, b] = octets(platformCidr(stage, region).split('/')[0]);
  return `${a}.${b}.${zoneIndex * 16}.0/20`;
}

// The lower /17 holds public /20s; the upper /17 is kept for private subnets.
const PUBLIC_SUBNET_ZONES_MAX = 8;

// The zones each region's network spans, named rather than looked up so a pipeline can synthesize without AWS
// credentials. Not every region has an 'a' and 'b': ap-northeast-1's zones are a, c and d.
const PLATFORM_AVAILABILITY_ZONES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'us-east-1': ['us-east-1a', 'us-east-1b'],
  'ap-northeast-1': ['ap-northeast-1a', 'ap-northeast-1c'],
  'eu-west-1': ['eu-west-1a', 'eu-west-1b'],
});

/** The availability zones a region's network spans, in order: zone i gets public subnet i. */
export function platformZones(region: string): string[] {
  const zones = PLATFORM_AVAILABILITY_ZONES[region];
  if (zones === undefined) throw new Error(`${region} is not a platform region`);
  return [...zones];
}

export const PLATFORM_VPC_NAME = 'gnome-platform';
export const PLATFORM_SECURITY_GROUP_NAME = 'gnome-platform-sg';
/** Tag on the VPC, its subnets and its security group; how the launcher and lookups find them. */
export const PLATFORM_NETWORK_TAG = { key: 'gnome:network', value: 'platform' } as const;

/** UDP ports the platform security group admits from every platform CIDR: Aeron, for streams read across regions. */
export const AERON_PORTS = Object.freeze({ from: 40000, to: 40999 });

/** Where each region's network is published, for callers that find it at run time rather than at synth. */
export const PLATFORM_SSM = Object.freeze({
  vpcId: '/gnome/platform-network/vpc-id',
  subnetIds: '/gnome/platform-network/subnet-ids',
  securityGroupId: '/gnome/platform-network/security-group-id',
});
