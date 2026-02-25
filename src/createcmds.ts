import ModuleInstance from './main.js'
import { getRequest } from './rest.js'
import { OpenAPIV3 } from 'openapi-types'
import { promises as fs } from 'fs'
import path from 'path'

export type LoadedSchemas = {
	mainSchema: OpenAPIV3.Document
	refSchemas: Record<string, OpenAPIV3.SchemaObject>
}

const SCHEMA_CACHE_DIR = './schemas'
const MAIN_SCHEMA_PATH = path.join(SCHEMA_CACHE_DIR, 'clearcom_api.json')

export async function loadSchemasAndRefs(self: ModuleInstance, deviceHost: string): Promise<LoadedSchemas> {
	await fs.mkdir(SCHEMA_CACHE_DIR, { recursive: true })

	const apiUrl = `${deviceHost}/api/1/schemas/clearcom_api.json`
	let mainSchema: OpenAPIV3.Document | null = null
	let downloadedNewMainSchema = false
	let cachedSchema: OpenAPIV3.Document | null = null

	// Try to load cached schema
	try {
		const raw = await fs.readFile(MAIN_SCHEMA_PATH, 'utf8')
		cachedSchema = JSON.parse(raw) as OpenAPIV3.Document
		self.log('info', `Loaded cached schema version ${cachedSchema.info.version}`)
	} catch (_err) {
		self.log('info', 'No cached schema found')
	}

	// Try to download live schema
	try {
		const res = await getRequest(apiUrl, self)
		if (res) {
			const liveSchema = res as OpenAPIV3.Document

			// Compare versions
			if (!cachedSchema || liveSchema.info.version !== cachedSchema.info.version) {
				mainSchema = liveSchema
				downloadedNewMainSchema = true
				await fs.writeFile(MAIN_SCHEMA_PATH, JSON.stringify(liveSchema, null, 2))
				self.log('info', `Downloaded schema version ${liveSchema.info.version}`)
			} else {
				mainSchema = cachedSchema
				self.log('info', 'Schema versions match, using cached')
			}
		} else {
			mainSchema = cachedSchema
			self.log('warn', 'Failed to download schema, using cached version')
		}
	} catch (err) {
		mainSchema = cachedSchema
		self.log('warn', `Error downloading schema: ${err}, using cached version`)
	}

	if (!mainSchema) {
		self.log('error', 'No schema available (cached or live)')
		return { mainSchema: {} as OpenAPIV3.Document, refSchemas: {} }
	}

	const refSchemas: Record<string, OpenAPIV3.SchemaObject> = {}
	const refs: Set<string> = new Set()

	const findRefs = (obj: any) => {
		if (typeof obj !== 'object' || obj === null) return
		for (const key in obj) {
			if (key === '$ref' && typeof obj[key] === 'string') {
				refs.add(obj[key])
			} else {
				findRefs(obj[key])
			}
		}
	}

	findRefs(mainSchema)

	for (const ref of refs) {
		if (ref.startsWith('#')) continue // internal OpenAPI ref, not a file
		console.log('found ref: ', ref)
		const filePath = path.join(SCHEMA_CACHE_DIR, ref)
		let shouldDownload = false

		try {
			await fs.access(filePath)
			if (downloadedNewMainSchema) {
				shouldDownload = true
			}
		} catch {
			shouldDownload = true
		}

		if (shouldDownload) {
			const refUrl = `${deviceHost}/api/1/schemas/${ref}`
			try {
				console.log('fetching: ', refUrl)
				const res = await fetch(refUrl, {
					headers: { Authorization: `Bearer ${self.bearerToken}` },
				})
				if (!res.ok) {
					self.log('warn', `Skipping $ref ${ref}: ${res.status}`)
					continue
				}
				const body = await res.text()
				await fs.mkdir(path.dirname(filePath), { recursive: true })
				await fs.writeFile(filePath, body)
				refSchemas[ref] = JSON.parse(body)
			} catch {
				continue
			}
		} else {
			try {
				const contents = await fs.readFile(filePath, 'utf8')
				refSchemas[ref] = JSON.parse(contents)
			} catch {
				continue
			}
		}
	}

	return { mainSchema, refSchemas }
}

/**
 * Check if a specific endpoint exists in the schema
 */
export function supportsEndpoint(schema: OpenAPIV3.Document, path: string, method: string = 'post'): boolean {
	const pathItem = schema.paths?.[path]
	if (!pathItem) return false
	return method.toLowerCase() in pathItem
}

/**
 * Get the API version from the schema
 */
export function getSchemaVersion(schema: OpenAPIV3.Document): string {
	return schema.info?.version || 'unknown'
}

/**
 * Get endpoint documentation from schema
 */
export function getEndpointInfo(
	schema: OpenAPIV3.Document,
	path: string,
	method: string = 'post',
): { summary?: string; description?: string } | null {
	const pathItem = schema.paths?.[path]
	if (!pathItem) return null
	const operation = pathItem[method.toLowerCase() as keyof typeof pathItem] as OpenAPIV3.OperationObject | undefined
	if (!operation) return null
	return {
		summary: operation.summary,
		description: operation.description,
	}
}
