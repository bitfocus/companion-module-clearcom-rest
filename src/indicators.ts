import type { CompanionAdvancedFeedbackResult } from '@companion-module/base'

// ─── Types ────────────────────────────────────────────────────────────────────

export type MeterStyle = 'bar-horizontal' | 'bar-vertical' | 'circle'

export interface MeterOptions {
	style: MeterStyle
	thickness: number // pixels
	min: number
	max: number
	yellowStart: number
	redStart: number
	value: number
	x?: number
	y?: number
	scale?: number
	width?: number
	height?: number
}

// ─── Constants ────────────────────────────────────────────────────────────────

const W = 72
const H = 72
const MARGIN = 4

// Arc: 7 o'clock (120°) clockwise 300° to 5 o'clock (60°)
// Angles in screen coords: 0° = right, clockwise positive
const ARC_START = 120
const ARC_SWEEP = 300

const TRACK: [number, number, number, number] = [0, 0, 0, 0]
const GREEN: [number, number, number, number] = [0x00, 0xcc, 0x00, 0xff]
const YELLOW: [number, number, number, number] = [0xff, 0xcc, 0x00, 0xff]
const RED: [number, number, number, number] = [0xff, 0x22, 0x00, 0xff]

// ─── Helpers ─────────────────────────────────────────────────────────────────

function setPixel(buf: Buffer, x: number, y: number, c: [number, number, number, number], w: number, h: number): void {
	if (x < 0 || x >= w || y < 0 || y >= h) return
	const i = (y * w + x) * 4
	buf[i] = c[0]
	buf[i + 1] = c[1]
	buf[i + 2] = c[2]
	buf[i + 3] = c[3]
}

function trackColor(
	posRatio: number,
	filledRatio: number,
	min: number,
	yellowStart: number,
	redStart: number,
	max: number,
	value: number,
): [number, number, number, number] | null {
	if (yellowStart > redStart) {
		// Reversed mode: transparent unfilled, single color based on current value
		if (posRatio > filledRatio) return TRACK
		if (value > yellowStart) return GREEN
		if (value > redStart) return YELLOW
		return RED
	}
	if (posRatio > filledRatio) return TRACK
	const posValue = min + posRatio * (max - min)
	if (posValue < yellowStart) return GREEN
	if (posValue < redStart) return YELLOW
	return RED
}

// ─── Bar ─────────────────────────────────────────────────────────────────────

function drawBar(buf: Buffer, vertical: boolean, opts: MeterOptions, filledRatio: number, w: number, h: number): void {
	const half = Math.floor(opts.thickness / 2)

	if (!vertical) {
		// Left → right
		const cy = Math.floor(h / 2)
		const trackLen = w - MARGIN * 2
		const y0 = cy - half
		const y1 = cy + half
		for (let x = MARGIN; x < w - MARGIN; x++) {
			const posRatio = (x - MARGIN) / (trackLen - 1)
			const c = trackColor(posRatio, filledRatio, opts.min, opts.yellowStart, opts.redStart, opts.max, opts.value)
			if (!c) continue
			for (let y = y0; y <= y1; y++) setPixel(buf, x, y, c, w, h)
		}
	} else {
		// Bottom → top
		const cx = Math.floor(w / 2)
		const trackLen = h - MARGIN * 2
		const x0 = cx - half
		const x1 = cx + half
		for (let y = MARGIN; y < h - MARGIN; y++) {
			const posRatio = (h - MARGIN - 1 - y) / (trackLen - 1)
			const c = trackColor(posRatio, filledRatio, opts.min, opts.yellowStart, opts.redStart, opts.max, opts.value)
			if (!c) continue
			for (let x = x0; x <= x1; x++) setPixel(buf, x, y, c, w, h)
		}
	}
}

// ─── Arc ─────────────────────────────────────────────────────────────────────

function drawArc(buf: Buffer, opts: MeterOptions, filledRatio: number, w: number, h: number): void {
	const cx = Math.floor(w / 2)
	const cy = Math.floor(h / 2)
	const outerR = cx - MARGIN
	const innerR = Math.max(1, outerR - opts.thickness)

	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			const dx = x - cx
			const dy = y - cy
			const dist = Math.sqrt(dx * dx + dy * dy)
			if (dist < innerR || dist > outerR) continue

			// atan2 in screen coords: 0°=right, clockwise positive
			let angle = Math.atan2(dy, dx) * (180 / Math.PI)
			if (angle < 0) angle += 360

			// Normalize relative to arc start
			const norm = (angle - ARC_START + 360) % 360
			if (norm > ARC_SWEEP) continue

			const posRatio = norm / ARC_SWEEP
			const c = trackColor(posRatio, filledRatio, opts.min, opts.yellowStart, opts.redStart, opts.max, opts.value)
			if (!c) continue
			setPixel(buf, x, y, c, w, h)
		}
	}
}

// ─── Public API ──────────────────────────────────────────────────────────────

export function drawMeter(
	opts: MeterOptions,
	imageWidth?: number,
	imageHeight?: number,
): CompanionAdvancedFeedbackResult {
	const w = opts.width ?? imageWidth ?? W
	const h = opts.height ?? imageHeight ?? H
	const buf = Buffer.alloc(w * h * 4, 0) // transparent

	const clamped = Math.max(opts.min, Math.min(opts.max, opts.value))
	const filledRatio = (clamped - opts.min) / (opts.max - opts.min)

	if (opts.style === 'circle') {
		drawArc(buf, opts, filledRatio, w, h)
	} else {
		drawBar(buf, opts.style === 'bar-vertical', opts, filledRatio, w, h)
	}

	return {
		imageBuffer: buf.toString('base64'),
		imageBufferEncoding: { pixelFormat: 'RGBA' },
		imageBufferPosition: { x: opts.x ?? 0, y: opts.y ?? 0, width: w, height: h, drawScale: opts.scale ?? 1 },
	}
}
