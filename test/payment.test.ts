import { encodePaymentRequiredHeader } from "@x402/core/http";
import { describe, expect, it } from "vitest";
import { checkChallenge } from "../src/payment.js";

const recipient = "0x0000000000000000000000000000000000000001";
const gateway = "http://127.0.0.1:4020";
const required = {
  x402Version: 2,
  resource: {
    url: `${gateway}/v1/facet-versions/00000000-0000-4000-8000-000000000001/invoke?fingerprint=abc`,
  },
  accepts: [
    {
      scheme: "exact",
      network: "eip155:43113",
      asset: "0xe7082a54a456dc4dfe0ceadcd0d0dce7d8ba176f",
      amount: "1000",
      payTo: recipient,
      maxTimeoutSeconds: 60,
      extra: { name: "FACET USD", version: "2" },
    },
  ],
};

describe("MCP payer guard", () => {
  it("accepts only a capped Fuji quote for its configured recipient", () => {
    expect(
      checkChallenge(
        encodePaymentRequiredHeader(required),
        recipient,
        1000n,
        gateway,
      ).accepts[0]?.amount,
    ).toBe("1000");
    expect(() =>
      checkChallenge(
        encodePaymentRequiredHeader(required),
        recipient,
        999n,
        gateway,
      ),
    ).toThrow("PAYMENT_CHALLENGE_NOT_ALLOWED");
    expect(() =>
      checkChallenge(
        encodePaymentRequiredHeader(required),
        "0x0000000000000000000000000000000000000002",
        1000n,
        gateway,
      ),
    ).toThrow("PAYMENT_CHALLENGE_NOT_ALLOWED");
  });
});
