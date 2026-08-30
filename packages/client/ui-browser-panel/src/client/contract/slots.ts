/**
 * Browser panel type definitions.
 */

/** Screenshot item stored in the browser panel state. */
export interface BrowserScreenshot {
  /** Unique identifier for the screenshot. */
  id: string
  /** Timestamp when the screenshot was taken. */
  timestamp: number
  /** URL of the page when screenshot was taken. */
  url: string
  /** Base64-encoded image data or file path. */
  imageData: string
  /** Optional title or description. */
  title?: string
}
