import { z } from "zod";

export const ExtractedItemSchema = z.object({
  as_written: z.string(),
  name: z.string(),
  strength: z.string().nullable(),
  quantity: z.number().nullable(),
  quantity_unit: z.enum(["pack", "unit"]).nullable(),
  confidence: z.number().min(0).max(1),
});
export type ExtractedItem = z.infer<typeof ExtractedItemSchema>;

export const ExtractionSchema = z.object({
  document_type: z.enum(["prescription", "medicine_photo", "text_request", "unreadable", "other"]),
  language: z.string(),
  items: z.array(ExtractedItemSchema),
});
export type Extraction = z.infer<typeof ExtractionSchema>;

export interface ExtractInput {
  text?: string;
  media?: { mimeType: string; data: Buffer };
  /** Product names the pharmacy stocks, to help read handwriting. */
  knownNames: string[];
}

export interface Extractor {
  readonly name: string;
  extract(input: ExtractInput): Promise<Extraction>;
}

/** The extractor's service is rate-limited or down; ask the customer to retry shortly. */
export class ExtractorBusyError extends Error {}
