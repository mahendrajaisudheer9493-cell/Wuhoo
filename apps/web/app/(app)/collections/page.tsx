import { requireOrganisation } from "@/lib/dal";
import { createClient } from "@/lib/supabase/server";
import { listCollections } from "@/lib/services/collections";
import { listCategories } from "@/lib/services/categories";
import { CollectionsList } from "./collections-list";

export default async function CollectionsPage() {
  const { membership } = await requireOrganisation();
  const org = membership.organisations as unknown as { id: string } | null;
  const orgId = org?.id ?? "";

  const supabase = await createClient();
  const collections = await listCollections(supabase, orgId);

  // Fetch categories for all collections in parallel.
  const categoryResults = await Promise.all(
    collections.map((col) => listCategories(supabase, col.id))
  );
  const categoriesByCollection: Record<string, Awaited<ReturnType<typeof listCategories>>> = {};
  collections.forEach((col, i) => {
    categoriesByCollection[col.id] = categoryResults[i];
  });

  const canDelete = membership.role === "owner" || membership.role === "admin";

  return (
    <CollectionsList
      collections={collections}
      categoriesByCollection={categoriesByCollection}
      canDelete={canDelete}
    />
  );
}
