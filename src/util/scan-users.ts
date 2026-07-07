import { TFile, TFolder, Vault } from "obsidian";
import { BASE_FOLDER } from "../constants";
import type { StellaUserProfile } from "../types/user";

export interface UserListItem {
  file: TFile;
  userFile: string;
  thumbnailPath: string | null;
  profile: StellaUserProfile;
}

export async function scanUsers(vault: Vault): Promise<UserListItem[]> {
  const folder = vault.getAbstractFileByPath(`${BASE_FOLDER}/USERS`);
  if (!(folder instanceof TFolder)) return [];

  const out: UserListItem[] = [];
  for (const child of folder.children) {
    if (!(child instanceof TFile) || child.extension !== "json") continue;
    try {
      const raw = JSON.parse(await vault.read(child)) as Partial<StellaUserProfile>;
      const profile = normalizeUserProfile(raw);
      const thumbRel = profile.thumbnail;
      const thumbPath =
        thumbRel && (await vault.adapter.exists(`${folder.path}/${thumbRel}`))
          ? `${folder.path}/${thumbRel}`
          : null;
      out.push({
        file: child,
        userFile: child.path,
        thumbnailPath: thumbPath,
        profile,
      });
    } catch (err) {
      console.warn("[GGAI Stella] user profile scan failed:", child.path, err);
    }
  }

  out.sort((a, b) => {
    if (a.profile.id === "default") return -1;
    if (b.profile.id === "default") return 1;
    return a.profile.name.localeCompare(b.profile.name);
  });
  return out;
}

export function normalizeUserProfile(
  raw: Partial<StellaUserProfile>
): StellaUserProfile {
  const now = Date.now();
  const name = typeof raw.name === "string" && raw.name.trim()
    ? raw.name.trim()
    : "User";
  return {
    id: typeof raw.id === "string" && raw.id.trim() ? raw.id : "default",
    name,
    description: typeof raw.description === "string" ? raw.description : "",
    thumbnail: typeof raw.thumbnail === "string" && raw.thumbnail ? raw.thumbnail : null,
    aliases: Array.isArray(raw.aliases)
      ? raw.aliases.filter((a): a is string => typeof a === "string")
      : [],
    favorite: raw.favorite === true,
    scenarioIds: Array.isArray(raw.scenarioIds)
      ? raw.scenarioIds.filter((s): s is string => typeof s === "string")
      : [],
    createdAt: typeof raw.createdAt === "number" ? raw.createdAt : now,
    modifiedAt: typeof raw.modifiedAt === "number" ? raw.modifiedAt : now,
  };
}
