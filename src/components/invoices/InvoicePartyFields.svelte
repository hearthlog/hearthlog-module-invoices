<script lang="ts">
    import { Field } from "@hearthlog/sdk/ui";
    import { Input } from "@hearthlog/sdk/ui";
    import { FoldLine } from "@hearthlog/sdk/ui";
    import type { InvoicePartyFormValues } from "../../invoices/document.js";

    /**
     * The fields of one company record. The record is role-free — bank account
     * and registration footer are company facts, rendered supplier-side on a
     * document but stored here for either use.
     */
    let { value = $bindable() }: { value: InvoicePartyFormValues } = $props();

    const uid = $props.id();
    // IČO and name, street, city; the tax and bank details fold (open when already filled).
    // svelte-ignore state_referenced_locally
    let detailsOpen = $state(Boolean(value.dic || value.bank_account || value.registration));
</script>

<div class="flex flex-col gap-2">
    <div class="grid grid-cols-[8.5rem_minmax(0,1fr)] gap-2">
        <label><span class="sr-only">Company ID (IČO)</span><Input id={`${uid}-ico`} inputmode="numeric" placeholder="IČO" bind:value={value.ico} /></label>
        <label><span class="sr-only">Name</span><Input id={`${uid}-name`} placeholder="Name" bind:value={value.name} /></label>
    </div>
    <label><span class="sr-only">Street</span><Input id={`${uid}-street`} placeholder="Street and number" bind:value={value.street} /></label>
    <label><span class="sr-only">City</span><Input id={`${uid}-city`} placeholder="PSČ and city, e.g. 110 00 Praha 1" bind:value={value.city} /></label>
    <div class="mt-2">
        <FoldLine bind:open={detailsOpen} tone="link" summary="VAT ID, bank account, registration">
            <Field label="VAT ID (DIČ)" htmlFor={`${uid}-dic`}><Input id={`${uid}-dic`} bind:value={value.dic} /></Field>
            <Field label="Bank account" htmlFor={`${uid}-bank`} hint="Printed when this company is the supplier."><Input id={`${uid}-bank`} placeholder="123456789/0100" bind:value={value.bank_account} /></Field>
            <Field label="Registration footer" htmlFor={`${uid}-registration`}><Input id={`${uid}-registration`} bind:value={value.registration} /></Field>
        </FoldLine>
    </div>
</div>
