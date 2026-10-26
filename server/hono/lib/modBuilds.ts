import type { Env } from '../types'

export interface ModBuildIdentity {
  modId: 'simukraft'
  minecraftVersion: string
  modVersion: string
  artifactSha256: string
}

export interface OfficialModBuild extends ModBuildIdentity {
  buildId: string
}

interface OfficialModBuildRow {
  id: string
  mod_id: string
  minecraft_version: string
  mod_version: string
  artifact_sha256: string
}

function boundedVersion(value: unknown, max: number): string {
  const text = String(value ?? '').trim()
  return text && text.length <= max && /^[0-9A-Za-z._+-]+$/.test(text) ? text : ''
}

export function parseModBuildIdentity(input: {
  mod_id?: unknown
  minecraft_version?: unknown
  mod_version?: unknown
  artifact_sha256?: unknown
}): ModBuildIdentity | null {
  const minecraftVersion = boundedVersion(input.minecraft_version, 32)
  const modVersion = boundedVersion(input.mod_version, 80)
  const artifactSha256 = String(input.artifact_sha256 ?? '')
    .trim()
    .toLowerCase()
  if (
    input.mod_id !== 'simukraft' ||
    !minecraftVersion ||
    !modVersion ||
    !/^[0-9a-f]{64}$/.test(artifactSha256)
  ) {
    return null
  }
  return { modId: 'simukraft', minecraftVersion, modVersion, artifactSha256 }
}

export async function findOfficialModBuild(
  env: Pick<Env, 'DB'>,
  identity: ModBuildIdentity,
): Promise<OfficialModBuild | null> {
  const row = await env.DB.prepare(
    `SELECT id, mod_id, minecraft_version, mod_version, artifact_sha256
       FROM official_mod_builds
      WHERE mod_id = ? AND minecraft_version = ? AND mod_version = ?
        AND artifact_sha256 = ? COLLATE NOCASE AND enabled = 1`,
  )
    .bind(identity.modId, identity.minecraftVersion, identity.modVersion, identity.artifactSha256)
    .first<OfficialModBuildRow>()
  if (!row) return null
  return {
    buildId: row.id,
    modId: 'simukraft',
    minecraftVersion: row.minecraft_version,
    modVersion: row.mod_version,
    artifactSha256: row.artifact_sha256.toLowerCase(),
  }
}
