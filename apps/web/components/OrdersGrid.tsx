"use client";
import { AgGridReact } from "ag-grid-react";
import type { ColDef } from "ag-grid-community";
import { accessibleGridOptions } from "./grid";

export type OrderRow = { id: string; date: string; store: string; items: string; amount: string; amountCents: number; status: string; delivery: string };

const columns: ColDef<OrderRow>[] = [
  { field: "date", headerName: "Date", width: 140 },
  { field: "store", headerName: "Store", width: 210 },
  { field: "items", headerName: "Items", flex: 2, minWidth: 260, wrapText: true, autoHeight: true },
  { field: "amount", headerName: "Amount", width: 130, comparator: (_a, _b, n1, n2) => (n1.data?.amountCents ?? 0) - (n2.data?.amountCents ?? 0) },
  { field: "status", headerName: "Status", width: 220 },
  { field: "delivery", headerName: "Delivery", flex: 1, minWidth: 220, wrapText: true, autoHeight: true },
];

export function OrdersGrid({ rows }: { rows: OrderRow[] }) {
  return (
    <div className="grid-wrap" role="region" aria-label="Order history table">
      <AgGridReact<OrderRow>
        {...accessibleGridOptions}
        rowData={rows}
        columnDefs={columns}
        defaultColDef={{ sortable: true, resizable: true }}
        getRowId={(p) => p.data.id}
        domLayout="autoHeight"
      />
    </div>
  );
}
