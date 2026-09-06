import { ProductHeader } from "../product-components";
import PoolsClient from "./PoolsClient";

export default function PoolsPage() {
  return (
    <main className="ex-pools">
      <ProductHeader />
      <PoolsClient />
    </main>
  );
}
