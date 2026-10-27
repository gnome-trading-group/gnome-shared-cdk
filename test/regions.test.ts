import {
  allPlatformCidrs, platformCidr, platformRegions, platformZoneIds, platformZones, PRIMARY_REGION, publicSubnetCidr, replicaRegions,
} from '../src/regions';

describe('platform regions', () => {
  it('lists regions in address-plan order, the primary first', () => {
    expect(platformRegions()).toEqual(['us-east-1', 'ap-northeast-1', 'eu-west-1']);
    expect(PRIMARY_REGION).toBe('us-east-1');
    expect(replicaRegions()).toEqual(['ap-northeast-1', 'eu-west-1']);
  });

  it('gives each region a /16 inside its account\'s /12', () => {
    expect(allPlatformCidrs('prod')).toEqual(['10.128.0.0/16', '10.129.0.0/16', '10.130.0.0/16']);
    expect(allPlatformCidrs('dev')).toEqual(['10.144.0.0/16', '10.145.0.0/16', '10.146.0.0/16']);
  });

  it('never overlaps across accounts or regions', () => {
    const all = [...allPlatformCidrs('prod'), ...allPlatformCidrs('dev')];
    expect(new Set(all).size).toBe(all.length);
    // Each account's /12 spans 16 second octets: prod 128-143, dev 144-159.
    for (const cidr of allPlatformCidrs('prod')) expect(Number(cidr.split('.')[1])).toBeLessThan(144);
    for (const cidr of allPlatformCidrs('dev')) expect(Number(cidr.split('.')[1])).toBeGreaterThanOrEqual(144);
  });

  it('cuts public /20s per zone from the bottom, leaving the upper /17', () => {
    expect(publicSubnetCidr('prod', 'eu-west-1', 0)).toBe('10.130.0.0/20');
    expect(publicSubnetCidr('prod', 'eu-west-1', 1)).toBe('10.130.16.0/20');
    expect(publicSubnetCidr('dev', 'us-east-1', 7)).toBe('10.144.112.0/20');
    expect(() => publicSubnetCidr('dev', 'us-east-1', 8)).toThrow(/lower \/17/);
  });

  it('refuses a region or stage outside the plan', () => {
    expect(() => platformCidr('prod', 'us-west-2')).toThrow(/not a platform region/);
    expect(() => platformCidr('staging', 'us-east-1')).toThrow(/No platform network/);
  });

  it('names every region\'s zones, so synth needs no lookup', () => {
    for (const region of platformRegions()) {
      const zones = platformZones(region);
      expect(zones).toHaveLength(2);
      expect(zones.every((z) => z.startsWith(region))).toBe(true);
    }
    expect(platformZones('ap-northeast-1')).toEqual(['ap-northeast-1a', 'ap-northeast-1c']);
  });

  it('says which physical zone each name is meant to be', () => {
    expect(platformZoneIds('us-east-1')).toEqual([
      { name: 'us-east-1a', id: 'use1-az2' }, { name: 'us-east-1b', id: 'use1-az4' },
    ]);
    for (const region of platformRegions()) {
      expect(platformZoneIds(region).map((z) => z.name)).toEqual(platformZones(region));
      expect(new Set(platformZoneIds(region).map((z) => z.id)).size).toBe(2);
    }
  });
});
