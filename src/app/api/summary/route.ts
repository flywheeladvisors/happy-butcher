import { dashboardStats, listStores, listWatchItems } from "@/lib/queries";

// Sidebar + stat cards, refreshed by the chat UI after each reply (tools may have changed the lists).
export async function GET() {
  const [stats, stores, watchItems] = await Promise.all([dashboardStats(), listStores(), listWatchItems()]);
  return Response.json({ stats, stores, watchItems });
}
