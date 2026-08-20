import { RouterErrorPage, RouterNotFoundPage } from "@/components/AppFallbackPage"
import { AppSidebar } from "@/components/AppSidebar"
import { SidebarProvider } from "@/components/ui/sidebar"
import { TooltipProvider } from "@/components/ui/tooltip"
import { MixpanelInit } from "@/core/analytics"
import { queryClient } from "@/core/queryClient"
import { CurrentUserTracker } from "@/core/UserContext"
import { Outlet, createRootRouteWithContext } from "@tanstack/react-router"

export interface RouterAppContext {
  queryClient: typeof queryClient
}

export const Route = createRootRouteWithContext<RouterAppContext>()({
  errorComponent: RouterErrorPage,
  notFoundComponent: RouterNotFoundPage,
  component: () => (
    <>
      <MixpanelInit />
      <CurrentUserTracker />
      <TooltipProvider>
        <SidebarProvider className="border-t">
          <AppSidebar />
          <Outlet />
        </SidebarProvider>
      </TooltipProvider>
    </>
  ),
})
