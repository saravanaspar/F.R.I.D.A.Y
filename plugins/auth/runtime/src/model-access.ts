/** Minimal model descriptor shape used by provider OAuth compatibility hooks.
 * Model availability is discovered live; this module intentionally holds no catalog.
 */
export interface AuthModelDescriptor {
  readonly id: string;
  readonly provider: string;
  readonly baseUrl?: string;
}
