import type { QueryClient } from "@tanstack/react-query"
import { queryKeys } from "./api"
import { upsertPageByCreatedAtDescending } from "./pageList"
import type { Page } from "./types"

export function syncPageCache(queryClient: QueryClient, page: Page) {
  queryClient.setQueryData(queryKeys.page(page.id), page)
  queryClient.setQueryData(queryKeys.pages, (currentPages: Page[] | undefined) => {
    return upsertPageByCreatedAtDescending(currentPages, page)
  })
}
