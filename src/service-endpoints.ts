import { PRIMARY_REGION } from './regions';

/**
 * Where sessions find the processes they connect to over Aeron: one item per live shard or order gateway, written by
 * the process itself and expiring when it stops writing. Created by gnome-shared-infra in the primary region; writers
 * and readers in every region use it there.
 */
export const SERVICE_ENDPOINTS = Object.freeze({
  tableName: 'service-endpoints',
  region: PRIMARY_REGION,
  /** `<kind>#<id>`, e.g. `shard#use1-e89064` or `order-gateway#kalshi`. */
  partitionKey: 'service_id',
  /** Epoch seconds; DynamoDB drops an item a process stopped refreshing. */
  ttlAttribute: 'expires_at',
});
