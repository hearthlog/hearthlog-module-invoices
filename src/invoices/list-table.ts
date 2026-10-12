import {
    columnFilteringFeature,
    createTableHook,
    rowSelectionFeature,
    rowSortingFeature,
    tableFeatures,
} from '@tanstack/svelte-table';

/** Table wiring only; the row and filter contracts live in `list-contracts.ts`. */
const features = tableFeatures({
    columnFilteringFeature,
    rowSortingFeature,
    rowSelectionFeature,
});

export const {
    createAppTable: createInvoiceListTable,
    createAppColumnHelper: createInvoiceListColumnHelper,
} = createTableHook({
    features,
});
