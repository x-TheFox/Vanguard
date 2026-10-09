/**
 * Auto-paginator — Transparently paginates through Pterodactyl list endpoints
 *
 * List endpoints in Pterodactyl return paginated results. This module
 * abstracts pagination away so that MCP tools return complete result sets
 * to Aegis without requiring it to understand pagination semantics.
 */

interface PageMeta {
  total: number;
  count: number;
  per_page: number;
  current_page: number;
  total_pages: number;
}

/** Auto-paginate through a Pterodactyl list endpoint, collecting all results */
export async function autoPaginate<T>(
  fetcher: (page: number) => Promise<{ data: T[]; meta: { pagination: PageMeta } }>,
  delayMs: number = 250,
): Promise<T[]> {
  let allResults: T[] = [];
  let currentPage = 1;
  let totalPages = 1;

  do {
    const response = await fetcher(currentPage);
    allResults = allResults.concat(response.data);
    totalPages = response.meta.pagination.total_pages;
    currentPage++;

    // Rate-limit-friendly delay between pages
    if (currentPage <= totalPages) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  } while (currentPage <= totalPages);

  return allResults;
}
