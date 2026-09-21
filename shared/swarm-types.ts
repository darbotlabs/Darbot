export type DarbotAgentIdentity = {
  agentId: string;
  identityCode: string;
  swarmIndex: number;
  displayName: string;
  domain: string;
  role: string;
  perspective: string;
  group: string;
  cohort: "solid64" | "mint-opal64";
  paletteToken: string;
  fallbackHex: string;
  material: {
    kind: "solid" | "opal-splatter";
    materialId: string | null;
    strength: number;
    fallbackColorIsApproximation: boolean;
  };
  avatar: {
    png1024: string;
    png512: string;
    png256?: string;
    transparent1024: string;
    transparent512?: string;
  };
  token: {
    png1024: string;
    png512: string;
    png256: string;
  };
  /** A source-code binding is not evidence of a configured or running service. */
  bindingKind: "framework" | "interaction" | "perspective";
  frameworkReference?: string;
};

export type AgentIdentitySubject = {
  id: string;
  name: string;
  avatarSeed: string;
  endpoint?: string | null;
};
