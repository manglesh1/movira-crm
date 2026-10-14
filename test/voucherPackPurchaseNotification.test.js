const test = require("node:test");
const assert = require("node:assert/strict");
const registry = require("../src/modules/notifications/eventRegistry");
const service = require("../src/modules/notifications/service");
const repository = require("../src/modules/notifications/repository");
const transactional = require("../src/modules/transactional/service");
const contacts = require("../src/modules/contacts/service");
const jobs = require("../src/modules/queueJobs/service");

const event = {
  eventType: "voucher.pack.purchased",
  locationId: 4,
  recipient: { email: "guest@example.com", name: "Guest" },
  payload: {
    guestName: "Guest",
    bookingNumber: "BK-VP-1",
    venueName: "Movira Park",
    voucherPackName: "Family Pack",
  },
  idempotencyKey: "voucher_pack_purchase:test",
  priority: "high",
};

test("voucher pack purchase is a registered notification event", () => {
  assert.equal(registry.isRegistered(event.eventType), true);
  assert.equal(registry.getEvent(event.eventType).sourceResourceType, "booking");
});

test("notification source follows the business event, not the delivery channel", async t => {
  t.mock.method(repository, 'findActiveBinding', async () => ({id:8,templateKey:'test',variableMap:{}}));
  t.mock.method(transactional, 'enqueueMessage', async () => ({duplicate:false,message:{id:9,status:'queued'}}));
  t.mock.method(jobs, 'enqueueAutomationEvents', async () => ({queued:true}));
  let captured;
  t.mock.method(contacts, 'upsertContact', async (input,options) => {
    captured=input;
    assert.equal(options.preserveExistingSource,true);
    return {contact:{id:10},created:true,tagsAdded:[]};
  });
  for (const [eventType,sourceType,extra] of [
    ['payment.received','booking',{amountPaid:'10.00'}],
    ['waiver.completed','movira',{}],
  ]) {
    const result=await service.ingestEvent({...event,eventType,payload:{...event.payload,...extra}});
    assert.equal(result.status,'queued');
    assert.equal(captured.sourceType,sourceType);
    assert.equal(captured.provider,'webhook','external identity keys remain compatible');
    assert.equal(captured.customFields.source,undefined);
  }
});

test("voucher pack purchase reaches the configured transactional binding", async (t) => {
  const requests = [];
  t.mock.method(repository, "findActiveBinding", async (scope) => {
    assert.deepEqual(scope, {
      eventType: "voucher.pack.purchased",
      channel: "email",
      locationId: 4,
    });
    return { id: 8, templateKey: "bookingConfirmation", variableMap: {} };
  });
  t.mock.method(transactional, "enqueueMessage", async (request) => {
    requests.push(request);
    return { duplicate: false, message: { id: 9, status: "queued" } };
  });
  t.mock.method(contacts, "upsertContact", async (input, options) => {
    assert.equal(input.sourceType, 'booking');
    assert.equal(input.provider, 'webhook');
    assert.equal(options.preserveExistingSource, true);
    assert.equal(input.customFields.source, undefined);
    assert.equal(input.customFields.lastEventSourceSystem, 'aeroSportsAdmin');
    return {contact: { id: 10 }, created: false, tagsAdded: []};
  });
  t.mock.method(jobs, "enqueueAutomationEvents", async () => ({ queued: true }));

  const result = await service.ingestEvent(event);

  assert.equal(result.eventType, "voucher.pack.purchased");
  assert.equal(result.templateKey, "bookingConfirmation");
  assert.equal(result.status, "queued");
  assert.equal(requests[0].sourceEventType, "voucher.pack.purchased");
});
