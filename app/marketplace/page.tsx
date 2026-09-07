import { ProductHeader } from "../product-components";
import MarketplaceClient from "./MarketplaceClient";

export default function MarketplacePage() {
  return (
    <main className="ex-marketplace">
      <ProductHeader />
      <MarketplaceClient />
    </main>
  );
}
