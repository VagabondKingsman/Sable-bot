import { VaultStore } from "@/lib/agent/vault/store";
import { dataDir } from "@/server/paths";

const KEY = Symbol.for("sable.vault.v1");

export function vaultStore(): VaultStore {
  const scope = globalThis as unknown as Record<symbol, VaultStore | undefined>;
  if (!scope[KEY]) scope[KEY] = new VaultStore(dataDir());
  return scope[KEY]!;
}
