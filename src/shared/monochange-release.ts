export interface MonochangeRelease {
  version: string;
  integrities: Record<string, string>;
}

// Embedded at build time; the consumer checkout never supplies these values.
declare const __MONOCHANGE_RELEASE__: MonochangeRelease;

export const monochangeRelease = __MONOCHANGE_RELEASE__;
