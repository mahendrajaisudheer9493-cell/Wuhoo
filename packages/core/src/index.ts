// @wuhoo/core — shared business logic

export type { SupabaseClientLike } from "./supabase.js";
export type { CollectionRow, CreateCollectionInput, UpdateCollectionInput, ServiceResult } from "./services/collections";
export { listCollections, createCollection, updateCollection, deleteCollection } from "./services/collections";

export type { CategoryRow } from "./services/categories";
export { listCategories, createCategory, updateCategory, deleteCategory } from "./services/categories";

export type { StepRow } from "./services/steps";
export { listSteps, createStep, updateStep, deleteStep, reorderSteps } from "./services/steps";

export type { DocumentRow, DocumentDetail, DocumentStats } from "./services/documents";
export { getDocumentStats, getRecentDocuments, listDocuments, getDocumentWithSteps, createDocument, updateDocument } from "./services/documents";

export type { MediaAssetRow } from "./services/media";
export { uploadScreenshot, getSignedUrl } from "./services/media";
