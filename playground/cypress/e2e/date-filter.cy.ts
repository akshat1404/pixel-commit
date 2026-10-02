// Happy-path walkthrough of the Events date filter, paced for a human viewer.
// cy.caption() already pauses ~1.5s; BEAT is the gap between actions.

export {};

const BEAT = 650;

describe("Events date filter", () => {
  beforeEach(() => {
    cy.visit("/");
  });

  it("lists every event when no filter is set", () => {
    cy.caption("With no date filter, every event is listed");
    cy.get("[data-testid=event-list]").scrollIntoView();
    cy.wait(BEAT);
    cy.get("[data-testid=event-item]").should("have.length", 8);
    cy.get("[data-testid=event-count]").should("have.text", "Showing 8 of 8 events");
    cy.wait(BEAT);
  });

  it("narrows the list to a date range", () => {
    cy.caption("Pick a start date: March 1, 2026");
    cy.get("[data-testid=filter-from]").type("2026-03-01");
    cy.wait(BEAT);
    cy.get("[data-testid=event-count]").should("have.text", "Showing 6 of 8 events");
    cy.wait(BEAT);

    cy.caption("Pick an end date: June 30, 2026");
    cy.get("[data-testid=filter-to]").type("2026-06-30");
    cy.wait(BEAT);

    cy.caption("Only the four events from March to June remain");
    cy.get("[data-testid=event-item]")
      .should("have.length", 4)
      .first()
      .should("contain.text", "Beta launch");
    cy.get("[data-testid=event-item]").last().should("contain.text", "Public release");
    cy.wait(BEAT);
  });

  it("restores the full list when the filter is cleared", () => {
    cy.caption("Filter to April only");
    cy.get("[data-testid=filter-from]").type("2026-04-01");
    cy.wait(BEAT);
    cy.get("[data-testid=filter-to]").type("2026-04-30");
    cy.wait(BEAT);
    cy.get("[data-testid=event-item]").should("have.length", 1).and("contain.text", "Team offsite");
    cy.wait(BEAT);

    cy.caption("Click Clear to show every event again");
    cy.get("[data-testid=filter-clear]").click();
    cy.wait(BEAT);
    cy.get("[data-testid=event-item]").should("have.length", 8);
    cy.get("[data-testid=filter-from]").should("have.value", "");
    cy.wait(BEAT);
  });
});
