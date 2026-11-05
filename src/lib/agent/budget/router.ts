/**
 * Model router (D8): grok-4.7 for hard steps; cheaper/local for light when configured.
 */
export type StepDifficulty = "light" | "hard";

export type RouterConfig = {
  hardModel: string;
  lightModel: string;
  /** When false, always hard model. */
  enabled: boolean;
};

export function readRouterConfig(env: NodeJS.ProcessEnv = process.env): RouterConfig {
  const hardModel = (env.SABLE_MODEL_HARD ?? env.SABLE_MODEL_DEFAULT ?? "grok-4.7").trim() || "grok-4.7";
  const lightModel = (env.SABLE_MODEL_LIGHT ?? env.SABLE_MODEL_CHEAP ?? "").trim();
  const enabled = (env.SABLE_MODEL_ROUTER ?? "1").trim() !== "0";
  return {
    hardModel,
    lightModel: lightModel || hardModel,
    enabled,
  };
}

export function pickModel(difficulty: StepDifficulty | undefined, env: NodeJS.ProcessEnv = process.env): string {
  const cfg = readRouterConfig(env);
  if (!cfg.enabled) return cfg.hardModel;
  if (difficulty === "light" && cfg.lightModel) return cfg.lightModel;
  return cfg.hardModel;
}
