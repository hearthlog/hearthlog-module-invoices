/**
 * ISDOC fixtures for the extraction tests. Not imported by application code.
 * Values are fictional.
 */

export const ISDOC_6_FULL = `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="http://isdoc.cz/namespace/2013" version="6.0.2">
  <DocumentType>1</DocumentType>
  <ID>2026-0042</ID>
  <UUID>0f9c2d2e-4d68-4b1f-9a11-6de1f3a2c001</UUID>
  <IssueDate>2026-09-01</IssueDate>
  <TaxPointDate>2026-09-01</TaxPointDate>
  <VATApplicable>true</VATApplicable>
  <LocalCurrencyCode>CZK</LocalCurrencyCode>
  <AccountingSupplierParty>
    <Party>
      <PartyIdentification>
        <ID>12345678</ID>
      </PartyIdentification>
      <PartyName>
        <Name>Dodavatel s.r.o.</Name>
      </PartyName>
      <PostalAddress>
        <StreetName>Ulice</StreetName>
        <BuildingNumber>12</BuildingNumber>
        <CityName>Praha</CityName>
        <PostalZone>110 00</PostalZone>
        <Country>
          <IdentificationCode>CZ</IdentificationCode>
          <Name>Česká republika</Name>
        </Country>
      </PostalAddress>
      <PartyTaxScheme>
        <CompanyID>CZ12345678</CompanyID>
        <TaxScheme>VAT</TaxScheme>
      </PartyTaxScheme>
    </Party>
  </AccountingSupplierParty>
  <AccountingCustomerParty>
    <Party>
      <PartyIdentification>
        <ID>87654321</ID>
      </PartyIdentification>
      <PartyName>
        <Name>Odběratel a.s.</Name>
      </PartyName>
      <PostalAddress>
        <StreetName>Vzorová</StreetName>
        <BuildingNumber>34</BuildingNumber>
        <CityName>Brno</CityName>
        <PostalZone>602 00</PostalZone>
        <Country>
          <IdentificationCode>CZ</IdentificationCode>
          <Name>Česká republika</Name>
        </Country>
      </PostalAddress>
      <PartyTaxScheme>
        <CompanyID>CZ87654321</CompanyID>
        <TaxScheme>VAT</TaxScheme>
      </PartyTaxScheme>
    </Party>
  </AccountingCustomerParty>
  <LegalMonetaryTotal>
    <TaxExclusiveAmount>250.00</TaxExclusiveAmount>
    <TaxInclusiveAmount>302.50</TaxInclusiveAmount>
    <PayableAmount>302.50</PayableAmount>
  </LegalMonetaryTotal>
  <TaxTotal>
    <TaxAmount>52.50</TaxAmount>
    <TaxSubTotal>
      <TaxableAmount>250.00</TaxableAmount>
      <TaxAmount>52.50</TaxAmount>
      <TaxCategory>
        <Percent>21</Percent>
      </TaxCategory>
    </TaxSubTotal>
  </TaxTotal>
  <InvoiceLines>
    <InvoiceLine>
      <InvoicedQuantity unitCode="ks">2.5</InvoicedQuantity>
      <UnitPrice>100.00</UnitPrice>
      <Item>
        <Description>Služby</Description>
      </Item>
      <ClassifiedTaxCategory>
        <Percent>21</Percent>
      </ClassifiedTaxCategory>
    </InvoiceLine>
  </InvoiceLines>
  <Payment>
    <Details>
      <PaymentDueDate>2026-09-15</PaymentDueDate>
      <ID>123456789</ID>
      <BankCode>0100</BankCode>
      <VariableSymbol>20260042</VariableSymbol>
    </Details>
  </Payment>
</Invoice>`;

/** ISDOC 5.x kept the same element names under an older namespace. */
export const ISDOC_5_NAMESPACE = `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="http://isdoc.cz/namespace/invoice" version="5.2">
  <ID>FA-5-100</ID>
  <IssueDate>2026-08-20</IssueDate>
  <VATApplicable>false</VATApplicable>
  <LocalCurrencyCode>CZK</LocalCurrencyCode>
  <AccountingSupplierParty>
    <Party>
      <PartyName>
        <Name>Starý Dodavatel</Name>
      </PartyName>
    </Party>
  </AccountingSupplierParty>
  <LegalMonetaryTotal>
    <TaxExclusiveAmount>1000.00</TaxExclusiveAmount>
    <PayableAmount>1000.00</PayableAmount>
  </LegalMonetaryTotal>
  <InvoiceLines>
    <InvoiceLine>
      <InvoicedQuantity>1</InvoicedQuantity>
      <UnitPrice>1000.00</UnitPrice>
      <Item>
        <Description>Poradenská činnost</Description>
      </Item>
    </InvoiceLine>
  </InvoiceLines>
  <Payment>
    <Details>
      <PaymentDueDate>2026-09-03</PaymentDueDate>
      <ID>987654321/0300</ID>
    </Details>
  </Payment>
</Invoice>`;

/** Declared amount disagrees with the line sums. */
export const ISDOC_MISMATCHED_TOTALS = `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="http://isdoc.cz/namespace/2013" version="6.0.2">
  <ID>2026-777</ID>
  <IssueDate>2026-09-02</IssueDate>
  <VATApplicable>true</VATApplicable>
  <LocalCurrencyCode>CZK</LocalCurrencyCode>
  <AccountingSupplierParty>
    <Party>
      <PartyName><Name>Chybný Dodavatel</Name></PartyName>
    </Party>
  </AccountingSupplierParty>
  <LegalMonetaryTotal>
    <TaxExclusiveAmount>100.00</TaxExclusiveAmount>
    <PayableAmount>999.00</PayableAmount>
  </LegalMonetaryTotal>
  <TaxTotal>
    <TaxAmount>21.00</TaxAmount>
  </TaxTotal>
  <InvoiceLines>
    <InvoiceLine>
      <InvoicedQuantity>1</InvoicedQuantity>
      <UnitPrice>100.00</UnitPrice>
      <Item><Description>Položka</Description></Item>
      <ClassifiedTaxCategory><Percent>21</Percent></ClassifiedTaxCategory>
    </InvoiceLine>
  </InvoiceLines>
  <Payment>
    <Details>
      <PaymentDueDate>2026-09-16</PaymentDueDate>
    </Details>
  </Payment>
</Invoice>`;

/** Minimal document missing most fields; used for warning coverage. */
export const ISDOC_MISSING_FIELDS = `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="http://isdoc.cz/namespace/2013" version="6.0.2">
  <ID>ONLY-ID</ID>
</Invoice>`;

/**
 * Real-world shape (Alza.cz NEO): four-decimal amounts, declared line
 * amounts, `PaymentMeans/Payment` nesting, and a zero payable amount on an
 * already-settled invoice.
 */
export const ISDOC_ALZA_SETTLED = `<?xml version="1.0" encoding="utf-8"?>
<Invoice xmlns="http://isdoc.cz/namespace/2013" version="6.0.2">
  <DocumentType>1</DocumentType>
  <ID>4027954462</ID>
  <IssueDate>2026-08-06</IssueDate>
  <TaxPointDate>2026-08-06</TaxPointDate>
  <VATApplicable>true</VATApplicable>
  <LocalCurrencyCode>CZK</LocalCurrencyCode>
  <AccountingSupplierParty>
    <Party>
      <PartyIdentification>
        <ID>27082440</ID>
      </PartyIdentification>
      <PartyName>
        <Name>Alza.cz a.s.</Name>
      </PartyName>
      <PostalAddress>
        <StreetName>Jankovcova</StreetName>
        <BuildingNumber>1522</BuildingNumber>
        <CityName>Praha 7</CityName>
        <PostalZone>17000</PostalZone>
        <Country>
          <IdentificationCode>CZ</IdentificationCode>
          <Name>Česká republika</Name>
        </Country>
      </PostalAddress>
      <PartyTaxScheme>
        <CompanyID>CZ27082440</CompanyID>
        <TaxScheme>VAT</TaxScheme>
      </PartyTaxScheme>
    </Party>
  </AccountingSupplierParty>
  <InvoiceLines>
    <InvoiceLine>
      <ID>3482581166</ID>
      <InvoicedQuantity unitCode="ks">1.0000</InvoicedQuantity>
      <LineExtensionAmount>216.6000</LineExtensionAmount>
      <LineExtensionAmountTaxInclusive>262.0800</LineExtensionAmountTaxInclusive>
      <LineExtensionTaxAmount>45.4800</LineExtensionTaxAmount>
      <UnitPrice>216.6000</UnitPrice>
      <ClassifiedTaxCategory>
        <Percent>21.0000</Percent>
        <VATCalculationMethod>0</VATCalculationMethod>
      </ClassifiedTaxCategory>
      <Item>
        <Description>Služba Alza NEO: 31.5" Dell S3221QSA - měsíční fakturace</Description>
      </Item>
    </InvoiceLine>
  </InvoiceLines>
  <TaxTotal>
    <TaxSubTotal>
      <TaxableAmount>216.6000</TaxableAmount>
      <TaxAmount>45.4800</TaxAmount>
      <TaxInclusiveAmount>262.0800</TaxInclusiveAmount>
      <TaxCategory>
        <Percent>21.0000</Percent>
      </TaxCategory>
    </TaxSubTotal>
    <TaxAmount>45.4800</TaxAmount>
  </TaxTotal>
  <LegalMonetaryTotal>
    <TaxExclusiveAmount>216.6000</TaxExclusiveAmount>
    <TaxInclusiveAmount>262.0800</TaxInclusiveAmount>
    <PayableRoundingAmount>-0.0800</PayableRoundingAmount>
    <PaidDepositsAmount>0.0000</PaidDepositsAmount>
    <PayableAmount>0.0000</PayableAmount>
  </LegalMonetaryTotal>
  <PaymentMeans>
    <Payment>
      <PaidAmount>0.0000</PaidAmount>
      <PaymentMeansCode>42</PaymentMeansCode>
      <Details>
        <PaymentDueDate>2026-08-16</PaymentDueDate>
        <ID>2171532</ID>
        <BankCode>0800</BankCode>
        <Name>Česká spořitelna, a.s.</Name>
        <IBAN />
        <BIC />
        <VariableSymbol>1502690505</VariableSymbol>
        <ConstantSymbol>0308</ConstantSymbol>
        <SpecificSymbol />
      </Details>
    </Payment>
  </PaymentMeans>
</Invoice>`;

export const NOT_ISDOC_XML = `<?xml version="1.0" encoding="UTF-8"?>
<SomethingElse><Value>1</Value></SomethingElse>`;
