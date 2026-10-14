const test = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');

test('CRM uses park/email identity, preserves source history, and never matches automation by phone',
  { skip: process.env.RUN_SHARED_RECORDS_DB_TEST !== '1' }, async () => {
  require('dotenv').config();
  const schema = `contact_source_test_${randomBytes(6).toString('hex')}`;
  process.env.CRM_DB_SCHEMA = schema;
  const Sequelize = require('sequelize');
  const s = require('../src/db/sequelize').getSequelize();
  const qi = s.getQueryInterface();
  const defineContact = require('../src/db/models/CrmContact');
  const models = { sequelize: s, CrmContact: defineContact(s),
    CrmContactIdentity: require('../src/db/models/CrmContactIdentity')(s),
    CrmContactTag: require('../src/db/models/CrmContactTag')(s),
    CrmContactFilterCount: { update: async () => [0] },
    CrmAutomationWorkflow: { findAll: async () => [] } };
  models.CrmContact.removeAttribute('originalSource');
  models.CrmContact.removeAttribute('sourceHistory');
  const migration = require('../migrations/20261013000600-preserve-contact-source-history');
  try {
    await s.createSchema(schema);
    for (const key of ['CrmContact','CrmContactIdentity','CrmContactTag']) await models[key].sync();
    await qi.addIndex({schema,tableName:'crm_contacts'}, ['locationId','normalizedEmail'], {unique:true});
    const old = await models.CrmContact.create({locationId:4,sourceType:'webhook',email:'old@example.invalid'});
    await migration.up(qi, Sequelize);
    models.CrmContact = defineContact(s);
    models.CrmContactIdentity.belongsTo(models.CrmContact, {as:'contact',foreignKey:'contactId'});
    require('../src/db/models').getModels = () => models;
    const contacts = require('../src/modules/contacts/service');
    const automation = require('../src/modules/automation/service');
    const historic = await models.CrmContact.findByPk(old.id);
    assert.equal(historic.originalSource.provenance,'legacy_snapshot');
    assert.equal(historic.originalSource.sourceType,'webhook');
    assert.deepEqual(historic.sourceHistory,[historic.originalSource]);

    const input = {locationId:4,email:' ONE@Example.invalid ',fullName:'One',phone:'+12895550100',locationCountry:'CA',sourceType:'manual',skipFilterCountInvalidation:true};
    const first = (await contacts.upsertContact(input)).contact;
    assert.equal(first.originalSource.sourceType,'manual');
    assert.equal(first.originalSource.provenance,'captured');
    const sharedPhone = (await contacts.upsertContact({...input,email:'two@example.invalid',fullName:'Two'})).contact;
    assert.notEqual(sharedPhone.id,first.id,'different emails sharing a phone are separate');
    const otherPark = (await contacts.upsertContact({...input,locationId:5})).contact;
    assert.notEqual(otherPark.id,first.id,'same email in different parks is separate');
    const sameEmail = (await contacts.upsertContact({...input,email:'one@example.invalid',phone:'+12895550199',sourceType:'csv',sourceRefType:'import',sourceRefId:'batch-1'})).contact;
    assert.equal(sameEmail.id,first.id,'same-park normalized email matches despite a changed phone');
    assert.equal(sameEmail.phone,'+12895550199');
    assert.deepEqual(sameEmail.originalSource,first.originalSource);
    assert.deepEqual(sameEmail.sourceHistory.map(x=>x.sourceType),['manual','csv']);
    assert.equal(sameEmail.sourceType,'csv','existing latest-source behavior remains compatible');
    const repeated = await contacts.upsertContact({...input,email:'one@example.invalid',sourceType:'csv',sourceRefType:'import',sourceRefId:'batch-1'});
    assert.equal(repeated.contact.sourceHistory.length,2,'repeated source does not inflate history');

    const updated = await contacts.updateContact(first.id,{locationId:4,sourceType:'api',sourceHistory:[],originalSource:{sourceType:'forged'}});
    assert.deepEqual(updated.originalSource,first.originalSource);
    assert.deepEqual(updated.sourceHistory.map(x=>x.sourceType),['manual','csv','api']);
    const row = await models.CrmContact.findByPk(first.id);
    await row.update({originalSource:{sourceType:'forged'},sourceHistory:[],fullName:'Updated'});
    await row.reload();
    assert.deepEqual(row.originalSource,first.originalSource,'direct writes cannot erase origin');
    assert.equal(row.sourceHistory.length,3,'non-source updates preserve history');
    await Promise.all(['form','webhook'].map(sourceType=>s.query(`UPDATE "${schema}".crm_contacts SET "sourceType"=:source WHERE id=:id`,{replacements:{source:sourceType,id:first.id}})));
    await row.reload();
    assert.equal(row.sourceHistory.length,5,'concurrent source changes both survive');

    // Core booking sync still resolves a known external ID even after an email edit.
    const booking = {...input,email:'booking@example.invalid',sourceType:'movira',provider:'movira',externalType:'guest',externalId:'764',sourceRefType:'guest',sourceRefId:'764'};
    const booked = (await contacts.upsertContact(booking)).contact;
    assert.equal((await contacts.upsertContact({...booking,email:'booking-updated@example.invalid'})).contact.id,booked.id);
    const phoneOnly = await automation.triggerWorkflowsForEvent({locationId:4,eventType:'contact.changed',phone:input.phone});
    assert.equal(phoneOnly.skipped,'contact_not_found');
    const wrongEmail = await automation.triggerWorkflowsForEvent({locationId:4,eventType:'contact.changed',email:'unknown@example.invalid',phone:input.phone});
    assert.equal(wrongEmail.skipped,'contact_not_found');
    assert.equal((await automation.triggerWorkflowsForEvent({locationId:4,eventType:'contact.changed',email:' ONE@example.invalid '})).contactId,first.id);
    assert.equal((await automation.triggerWorkflowsForEvent({locationId:5,eventType:'contact.changed',email:'one@example.invalid'})).contactId,otherPark.id);
    assert.equal((await automation.triggerWorkflowsForEvent({locationId:4,eventType:'contact.changed',contactId:booked.id})).contactId,booked.id);

    // Raw SQL is also used by the core chat service, so it must capture origin.
    await s.query(`INSERT INTO "${schema}".crm_contacts (id,"locationId","sourceType","communicationOnly","createdAt","updatedAt")
      VALUES (gen_random_uuid(),4,'conversation',true,now(),now())`);
    const chat = await models.CrmContact.findOne({where:{communicationOnly:true}});
    assert.equal(chat.originalSource.sourceType,'conversation');
    assert.equal(chat.sourceHistory.length,1);
    assert.equal((await automation.triggerWorkflowsForEvent({locationId:4,eventType:'contact.changed',contactId:chat.id})).skipped,'contact_not_found');
    const count = await models.CrmContact.count();
    await migration.down(qi);
    assert.equal(Number((await s.query(`SELECT count(*) FROM "${schema}".crm_contacts`))[0][0].count),count);
    await migration.up(qi, Sequelize);
    assert.equal(await models.CrmContact.count(),count,'migration rollback/reapply keeps contacts');
  } finally {
    // Only this test's randomly named schema is removed.
    await s.dropSchema(schema,{cascade:true});
    await s.close();
  }
});
