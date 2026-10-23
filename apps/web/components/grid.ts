"use client";
/**
 * AG Grid set-up shared by every grid in Open Aisle.
 *
 * AG Grid is built for keyboard and screen-reader use: arrow keys move cell
 * to cell and each cell is announced with its column name. Two settings make
 * that reliable for screen readers: rows and columns stay in DOM order and are
 * never virtualised away (our tables are small, so this costs nothing).
 */
import { AllCommunityModule, ModuleRegistry, themeQuartz, type GridOptions } from "ag-grid-community";

ModuleRegistry.registerModules([AllCommunityModule]);

export const gridTheme = themeQuartz.withParams({
  fontFamily: "Atkinson Hyperlegible, system-ui, sans-serif",
  fontSize: 18,
  headerFontSize: 18,
  headerFontWeight: 700,
  rowHeight: 56,
  headerHeight: 56,
  foregroundColor: "#0e2a47",
  backgroundColor: "#ffffff",
  headerBackgroundColor: "#eef2f7",
  borderColor: "#b9c4d2",
  accentColor: "#0e2a47",
  rangeSelectionBorderColor: "#0e2a47",
  focusShadow: { spread: 4, color: "#ffd23f" },
  oddRowBackgroundColor: "#f7f9fc",
});

export const accessibleGridOptions: GridOptions = {
  theme: gridTheme,
  ensureDomOrder: true,
  suppressColumnVirtualisation: true,
  suppressRowVirtualisation: true,
  enableCellTextSelection: true,
  stopEditingWhenCellsLoseFocus: true,
};
