/** Normalized images are encoded by our media pipeline, never arbitrary model paths/URLs. */
export interface ChatImage { type: "image"; data: string; mimeType: string }
export interface MemoryCandidate { text: string }
export class UserError extends Error {}
