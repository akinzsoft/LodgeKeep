import { useEffect, useState } from "react";
import { DataTable } from "../../shared/components/index.js";
import { Money } from "../../shared/format/money.jsx";
import { stockApi, ApiError } from "../../shared/api/index.js";
import { formatQuantity } from "./stockFormat.js";
import formStyles from "./POSForm.module.css";

/**
 * Menu items whose recipe cost is at or above their selling price — almost always a
 * wrong stock cost. Not date driven (it reads today's recipe, cost and price). Each
 * row names the stock items behind the cost so the bad one can be corrected under
 * Stock items → Edit (cost price, with a reason).
 */
export function CostCheckCard({ activeProperty }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let current = true;
    stockApi
      .getCostCheck()
      .then((result) => current && setRows(result.rows))
      .catch(
        (caught) =>
          current &&
          setError(
            caught instanceof ApiError
              ? caught.message
              : "Could not load the cost check.",
          ),
      );
    return () => {
      current = false;
    };
  }, []);

  const currency = activeProperty.base_currency;
  return (
    <>
      <p className={formStyles.hint}>
        Usually a mistyped stock cost. Fix it under Stock items → Edit → Cost
        price.
      </p>
      <DataTable
        title="Cost check — items costed at or above their selling price"
        state={
          error
            ? "error"
            : rows === null
              ? "loading"
              : rows.length === 0
                ? "empty"
                : "success"
        }
        errorMessage={error ?? undefined}
        emptyMessage="No item costs as much as it sells for."
        columns={[
          { key: "name", label: "Menu item" },
          {
            key: "price",
            label: "Selling price",
            align: "right",
            render: (row) => (
              <Money amount={row.price} currencyCode={currency} />
            ),
          },
          {
            key: "unitCost",
            label: "Cost per sale",
            align: "right",
            render: (row) => (
              <Money amount={row.unitCost} currencyCode={currency} />
            ),
          },
          {
            key: "components",
            label: "Stock items behind the cost",
            render: (row) =>
              row.components
                .map(
                  (c) =>
                    `${c.name} (${formatQuantity(c.quantity, c.unit)} at ${c.purchaseCost})`,
                )
                .join(", "),
          },
        ]}
        rows={rows ?? []}
        rowKey={(row) => row.menuItemId}
      />
    </>
  );
}
