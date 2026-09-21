import Link from "next/link";
import { notFound } from "next/navigation";
import CutHistory from "@/components/CutHistory";
import Sidebar from "@/components/Sidebar";
import { cutHistory, getWatchItem, listStores, listWatchItems } from "@/lib/queries";

export const dynamic = "force-dynamic";

export default async function CutPage({ params }: PageProps<"/cuts/[id]">) {
  const id = Number((await params).id);
  if (!Number.isInteger(id)) notFound();
  const item = await getWatchItem(id);
  if (!item) notFound();
  const [stores, watchItems, points] = await Promise.all([listStores(), listWatchItems(), cutHistory(item)]);

  return (
    <div className="h-dvh p-0 md:p-6 lg:p-10">
      <div className="mx-auto flex h-full max-w-7xl overflow-hidden bg-white md:rounded-2xl md:border md:border-neutral-200 md:shadow-sm">
        <Sidebar stores={stores} watchItems={watchItems} activeCutId={item.id} />
        <main className="flex min-w-0 flex-1 flex-col">
          <header className="flex items-center gap-2 border-b border-neutral-100 px-4 py-3 text-[13px] text-neutral-500 md:px-6">
            <Link href="/" className="hover:text-neutral-900">
              Butcher counter
            </Link>
            <span className="text-neutral-300">/</span>
            <span className="text-neutral-900">{item.name}</span>
          </header>
          <div className="flex-1 overflow-y-auto px-4 py-6 md:px-8">
            <div className="mx-auto max-w-4xl">
              <h1 className="text-xl font-semibold tracking-tight">{item.name}</h1>
              <p className="mt-1 text-[13px] text-neutral-500">
                Price by ad week at each of your stores. Hover a point for the store, product, and deal.
              </p>
              <div className="hatch my-5 h-3" />
              <CutHistory points={points} />
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
