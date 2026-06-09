import ModuleInstance from './main.js'
import { makeLogger } from './logger.js'
import { filterSchema, type CachedSchema, type ModuleConfig } from './config.js'
import { getRequest } from './network.js'
import { OpenAPIV3 } from 'openapi-types'
import { writeFile, mkdir } from 'fs/promises'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const SCHEMAS_BASE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'schemas')

let _instance: ModuleInstance | null = null
const log = makeLogger('loadSchemas', () => _instance?.config)

export type LoadedSchemas = {
	mainSchema: OpenAPIV3.Document
	refSchemas: Record<string, OpenAPIV3.SchemaObject>
}

export async function loadSchemasAndRefs(
	self: ModuleInstance,
	deviceHost: string,
	offlineOnly = false,
): Promise<LoadedSchemas> {
	_instance = self

	const deviceType = (self.deviceInfo?.deviceType_name ?? 'unknown').toUpperCase()
	const rawVersion = self.deviceInfo?.versionSW ?? self.deviceInfo?.device_versionSW ?? 'unknown'
	const firmwareVersion = rawVersion.split(' ')[0]
	const cacheKey = `${deviceType}_${firmwareVersion}`
	const cached = self.config.schemaCache?.[cacheKey]
	const fallback = cached ?? Object.values(self.config.schemaCache ?? {}).find(Boolean)

	const apiUrl = `${deviceHost}/api/1/schemas/clearcom_api.json`
	let mainSchema: OpenAPIV3.Document | null = null
	let refSchemas: Record<string, OpenAPIV3.SchemaObject> = {}

	if (fallback) {
		log.info(`Loaded cached schema for ${cacheKey}${fallback !== cached ? ' (fallback)' : ''}`)
		mainSchema = fallback.data as unknown as OpenAPIV3.Document
		refSchemas = (fallback.data['refs'] as Record<string, OpenAPIV3.SchemaObject>) ?? {}
	}

	if (offlineOnly) {
		if (!mainSchema) throw new Error('No cached schema available for offline mode')
		return { mainSchema, refSchemas }
	}
	try {
		const res = await getRequest(apiUrl, self)
		if (res) {
			const liveSchema = res as OpenAPIV3.Document
			if (!cached) {
				log.info(`No cached schema for ${cacheKey}, downloading from device`)

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

				const filtered = filterSchema(liveSchema as unknown as Record<string, unknown>, deviceType)
				filtered['refs'] = fetchedRefs

				const updatedCache = {
					...(self.config.schemaCache ?? {}),
					[cacheKey]: { version: firmwareVersion, data: filtered as unknown as CachedSchema['data'] },
				}
				self.saveConfig({ ...self.config, schemaCache: updatedCache }, undefined)

				mainSchema = filtered as unknown as OpenAPIV3.Document
				refSchemas = fetchedRefs

				void writeSchemasToDir(cacheKey, mainSchema, refSchemas)
			} else {
				log.info(`Schema already cached for ${cacheKey}, using cached`)
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

export function clearSchemaCache(config: ModuleConfig): ModuleConfig {
	return { ...config, schemaCache: {}, refreshSchema: false }
}

async function writeSchemasToDir(
	cacheKey: string,
	mainSchema: OpenAPIV3.Document,
	refs: Record<string, unknown>,
): Promise<void> {
	const schemasDir = join(SCHEMAS_BASE_DIR, cacheKey)
	const mainSchemaPath = join(schemasDir, 'clearcom_api.json')

	try {
		await mkdir(schemasDir, { recursive: true })
		await mkdir(join(schemasDir, 'request_schemas'), { recursive: true })
		await mkdir(join(schemasDir, 'response_schemas'), { recursive: true })
		await writeFile(mainSchemaPath, JSON.stringify(mainSchema, null, 2))
		for (const [refPath, refSchema] of Object.entries(refs)) {
			const fullPath = join(schemasDir, refPath)
			await mkdir(dirname(fullPath), { recursive: true })
			await writeFile(fullPath, JSON.stringify(refSchema, null, 2))
		}
		log.info(`Schemas written to schemas/${cacheKey}/`)
	} catch (err) {
		log.warn(`Could not write schemas to disk: ${err}`)
	}
}

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
