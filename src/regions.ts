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

// The zones each region's network spans, by name and by zone ID. Names are what CloudFormation takes, but a name can
// be a different physical zone in another account; the ID is the physical zone, the same everywhere, and is what is
// meant (checked against both accounts 2026-10-27: these names are these IDs in dev and prod). Named rather than looked
// up so a pipeline synthesizes without credentials. Append only: zone i gets public subnet i, so reordering or removing
// a zone moves every later subnet's range and replaces it. Not every region has an 'a' and 'b' (ap-northeast-1 has a,
// c and d).
export interface PlatformZone {
  name: string;
  id: string;
}

const PLATFORM_AVAILABILITY_ZONES: Readonly<Record<string, readonly PlatformZone[]>> = Object.freeze({
  'us-east-1': [{ name: 'us-east-1a', id: 'use1-az2' }, { name: 'us-east-1b', id: 'use1-az4' }],
  'ap-northeast-1': [{ name: 'ap-northeast-1a', id: 'apne1-az4' }, { name: 'ap-northeast-1c', id: 'apne1-az1' }],
  'eu-west-1': [{ name: 'eu-west-1a', id: 'euw1-az2' }, { name: 'eu-west-1b', id: 'euw1-az3' }],
});

/** The zones a region's network spans, in order: zone i gets public subnet i. */
export function platformZoneIds(region: string): PlatformZone[] {
  const zones = PLATFORM_AVAILABILITY_ZONES[region];
  if (zones === undefined) throw new Error(`${region} is not a platform region`);
  return zones.map((z) => ({ ...z }));
}

/** The zones' names, in order, as CloudFormation takes them. */
export function platformZones(region: string): string[] {
  return platformZoneIds(region).map((z) => z.name);
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
