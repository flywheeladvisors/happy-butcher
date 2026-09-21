import ButcherApp from "@/components/ButcherApp";
import { dashboardStats, listStores, listWatchItems } from "@/lib/queries";

export const dynamic = "force-dynamic";

export default async function Home() {
  const [stats, stores, watchItems] = await Promise.all([dashboardStats(), listStores(), listWatchItems()]);
  return <ButcherApp initial={{ stats, stores, watchItems }} />;
}
