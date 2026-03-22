import ModuleInstance from './main.js'
import { makeLogger } from './logger.js'
import { filterSchema, type CachedSchema, type ModuleConfig } from './config.js'
import { getRequest } from './network.js'
import { OpenAPIV3 } from 'openapi-types'

let _instance: ModuleInstance | null = null
const log = makeLogger('loadSchemas', () => _instance?.config)

// ─── Types ────────────────────────────────────────────────────────────────────

export type LoadedSchemas = {
	mainSchema: OpenAPIV3.Document
	refSchemas: Record<string, OpenAPIV3.SchemaObject>
}

// ─── Schema loading (version-aware, config-cached, per-device filtered) ───────

export async function loadSchemasAndRefs(self: ModuleInstance, deviceHost: string): Promise<LoadedSchemas> {
	_instance = self

	// Device type is only known after fetchDevice — use 'unknown' as a fallback key
	// until deviceInfo is populated. In practice, connect() fetches device info first.
	const deviceType = (self.deviceInfo?.deviceType_name ?? 'unknown').toUpperCase()
	const cached = self.config.schemaCache?.[deviceType]

	const apiUrl = `${deviceHost}/api/1/schemas/clearcom_api.json`
	let mainSchema: OpenAPIV3.Document | null = null
	let refSchemas: Record<string, OpenAPIV3.SchemaObject> = {}

	if (cached) {
		log.info(`Loaded cached schema version ${cached.version} for ${deviceType}`)
		mainSchema = cached.data as unknown as OpenAPIV3.Document
		// refs are embedded in the cached data under a 'refs' key
		refSchemas = (cached.data['refs'] as Record<string, OpenAPIV3.SchemaObject>) ?? {}
	}

	// Try to fetch live schema to check version
	try {
		const res = await getRequest(apiUrl, self)
		if (res) {
			const liveSchema = res as OpenAPIV3.Document
			if (!cached || liveSchema.info.version !== cached.version) {
				log.info(`Downloading schema version ${liveSchema.info.version} for ${deviceType}`)

				// Fetch all $refs
				const refs = collectRefs(liveSchema)
				const fetchedRefs: Record<string, OpenAPIV3.SchemaObject> = {}
				for (const ref of refs) {
					if (ref.startsWith('#')) continue
					const refUrl = `${deviceHost}/api/1/schemas/${ref}`
					try {
						const refRes = await fetch(refUrl, {
							headers: { Authorization: `Bearer ${self.bearerToken}` },
						})
						if (!refRes.ok) {
							log.warn(`Skipping $ref ${ref}: ${refRes.status}`)
							continue
						}
						fetchedRefs[ref.replace(/^\.\//, '')] = (await refRes.json()) as OpenAPIV3.SchemaObject
					} catch {
						continue
					}
				}

				// Filter schema paths for this device type, embed refs, then cache
				const filtered = filterSchema(liveSchema as unknown as Record<string, unknown>, deviceType)
				filtered['refs'] = fetchedRefs

				const updatedCache = {
					...(self.config.schemaCache ?? {}),
					[deviceType]: { version: liveSchema.info.version, data: filtered as unknown as CachedSchema['data'] },
				}
				self.saveConfig({ ...self.config, schemaCache: updatedCache } as ModuleConfig, undefined)

				mainSchema = filtered as unknown as OpenAPIV3.Document
				refSchemas = fetchedRefs
			} else {
				log.info(`Schema versions match (${cached.version}), using cached`)
			}
		} else if (!mainSchema) {
			throw new Error('Schema download returned empty response and no cache available')
		} else {
			log.warn('Failed to download schema, using cached version')
		}
	} catch (err) {
		if (!mainSchema) throw new Error(`No schema available: ${String(err)}`)
		log.warn(`Error downloading schema: ${err}, using cached version`)
	}

	return { mainSchema: mainSchema!, refSchemas }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function collectRefs(obj: unknown, found: Set<string> = new Set()): Set<string> {
	if (typeof obj !== 'object' || obj === null) return found
	for (const key in obj as Record<string, unknown>) {
		if (key === '$ref' && typeof (obj as Record<string, unknown>)[key] === 'string') {
			found.add((obj as Record<string, unknown>)[key] as string)
		} else {
			collectRefs((obj as Record<string, unknown>)[key], found)
		}
	}
	return found
}
