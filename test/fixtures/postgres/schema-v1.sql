--
-- PostgreSQL database dump
--


-- Dumped from database version 17.11 (Debian 17.11-1.pgdg13+2)
-- Dumped by pg_dump version 17.11 (Debian 17.11-1.pgdg13+2)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: relembra_fixture; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA relembra_fixture;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: erasure_outbox; Type: TABLE; Schema: relembra_fixture; Owner: -
--

CREATE TABLE relembra_fixture.erasure_outbox (
    seq bigint NOT NULL,
    memory_id text NOT NULL,
    carriers text NOT NULL
);


--
-- Name: events; Type: TABLE; Schema: relembra_fixture; Owner: -
--

CREATE TABLE relembra_fixture.events (
    seq bigint NOT NULL,
    kind text NOT NULL,
    memory_id text NOT NULL,
    scope text NOT NULL,
    body text NOT NULL
);


--
-- Name: fences; Type: TABLE; Schema: relembra_fixture; Owner: -
--

CREATE TABLE relembra_fixture.fences (
    key text NOT NULL,
    epoch bigint NOT NULL
);


--
-- Name: import_checkpoints; Type: TABLE; Schema: relembra_fixture; Owner: -
--

CREATE TABLE relembra_fixture.import_checkpoints (
    source text NOT NULL,
    bytes bigint NOT NULL,
    width integer NOT NULL
);


--
-- Name: memories; Type: TABLE; Schema: relembra_fixture; Owner: -
--

CREATE TABLE relembra_fixture.memories (
    "position" bigint NOT NULL,
    id text NOT NULL,
    scope text NOT NULL,
    seq bigint NOT NULL,
    pinned boolean NOT NULL,
    noted_at bigint NOT NULL,
    revision_number integer NOT NULL,
    text text NOT NULL,
    revised_at bigint NOT NULL,
    provenance text NOT NULL,
    status text NOT NULL,
    superseded_by text,
    sources text,
    CONSTRAINT memories_status_check CHECK ((status = ANY (ARRAY['live'::text, 'retracted'::text, 'superseded'::text])))
);


--
-- Name: memories_position_seq; Type: SEQUENCE; Schema: relembra_fixture; Owner: -
--

ALTER TABLE relembra_fixture.memories ALTER COLUMN "position" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME relembra_fixture.memories_position_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: ops; Type: TABLE; Schema: relembra_fixture; Owner: -
--

CREATE TABLE relembra_fixture.ops (
    principal_id text NOT NULL,
    op_id text NOT NULL,
    fingerprint text,
    memory_id text NOT NULL,
    at bigint NOT NULL,
    seq bigint NOT NULL
);


--
-- Name: schema_version; Type: TABLE; Schema: relembra_fixture; Owner: -
--

CREATE TABLE relembra_fixture.schema_version (
    version integer NOT NULL,
    applied_at bigint NOT NULL
);


--
-- Name: store_lock; Type: TABLE; Schema: relembra_fixture; Owner: -
--

CREATE TABLE relembra_fixture.store_lock (
    id integer NOT NULL,
    CONSTRAINT store_lock_id_check CHECK ((id = 1))
);


--
-- Name: term_docs; Type: TABLE; Schema: relembra_fixture; Owner: -
--

CREATE TABLE relembra_fixture.term_docs (
    "position" bigint NOT NULL,
    memory_id text NOT NULL,
    scope text NOT NULL,
    seq bigint NOT NULL,
    length_all integer NOT NULL,
    length_kept integer NOT NULL
);


--
-- Name: term_postings; Type: TABLE; Schema: relembra_fixture; Owner: -
--

CREATE TABLE relembra_fixture.term_postings (
    scope text NOT NULL,
    form smallint NOT NULL,
    term text NOT NULL,
    "position" bigint NOT NULL,
    count_all integer NOT NULL,
    count_kept integer NOT NULL
);


--
-- Name: term_scopes; Type: TABLE; Schema: relembra_fixture; Owner: -
--

CREATE TABLE relembra_fixture.term_scopes (
    scope text NOT NULL,
    memories bigint NOT NULL,
    length_all bigint NOT NULL,
    length_kept bigint NOT NULL
);


--
-- Name: tombstones; Type: TABLE; Schema: relembra_fixture; Owner: -
--

CREATE TABLE relembra_fixture.tombstones (
    id text NOT NULL,
    scope text NOT NULL,
    seq bigint NOT NULL
);


--
-- Data for Name: erasure_outbox; Type: TABLE DATA; Schema: relembra_fixture; Owner: -
--

INSERT INTO relembra_fixture.erasure_outbox VALUES (11, 'm-gone', '[]');


--
-- Data for Name: events; Type: TABLE DATA; Schema: relembra_fixture; Owner: -
--

INSERT INTO relembra_fixture.events VALUES (1, 'note', 'm-pinned', 'fixture/a', '{"format":1,"kind":"note","memoryId":"m-pinned","scope":"fixture/a","principalId":"fixture-owner","pinned":true,"revision":{"number":1,"text":"Releases are cut on Thursdays.","at":1000,"provenance":{"agent":"fixture-agent","harness":"fixture","model":"none","host":"fixture","trust":"owner","opId":"op-pinned"}}}');
INSERT INTO relembra_fixture.events VALUES (2, 'note', 'm-old', 'fixture/a', '{"format":1,"kind":"note","memoryId":"m-old","scope":"fixture/a","principalId":"fixture-owner","pinned":false,"revision":{"number":1,"text":"Deploys run from the main branch.","at":2000,"provenance":{"agent":"fixture-agent","harness":"fixture","model":"none","host":"fixture","trust":"owner","opId":"op-old"}}}');
INSERT INTO relembra_fixture.events VALUES (3, 'note', 'm-new', 'fixture/a', '{"format":1,"kind":"note","memoryId":"m-new","scope":"fixture/a","principalId":"fixture-owner","pinned":false,"revision":{"number":1,"text":"Deploys run from the release branch.","at":3000,"provenance":{"agent":"fixture-agent","harness":"fixture","model":"none","host":"fixture","trust":"agent","opId":"op-new"}}}');
INSERT INTO relembra_fixture.events VALUES (4, 'supersede', 'm-old', 'fixture/a', '{"format":1,"kind":"supersede","memoryId":"m-old","scope":"fixture/a","principalId":"fixture-owner","by":"m-new"}');
INSERT INTO relembra_fixture.events VALUES (5, 'note', 'm-sourced', 'fixture/a', '{"format":1,"kind":"note","memoryId":"m-sourced","scope":"fixture/a","principalId":"fixture-owner","pinned":false,"revision":{"number":1,"text":"The agent reviews each release.","at":4000,"provenance":{"agent":"fixture-agent","harness":"fixture","model":"none","host":"fixture","trust":"owner","opId":"op-sourced"}}}');
INSERT INTO relembra_fixture.events VALUES (6, 'summarize', 'm-summary', 'fixture/a', '{"format":1,"kind":"summarize","memoryId":"m-summary","scope":"fixture/a","principalId":"fixture-owner","sources":[{"memoryId":"m-sourced","revision":1}],"revision":{"number":1,"text":"Summary: releases are reviewed.","at":5000,"provenance":{"agent":"fixture-agent","harness":"fixture","model":"none","host":"fixture","trust":"agent","opId":"op-summary"}}}');
INSERT INTO relembra_fixture.events VALUES (7, 'retract', 'm-sourced', 'fixture/a', '{"format":1,"kind":"retract","memoryId":"m-sourced","scope":"fixture/a","principalId":"fixture-owner"}');
INSERT INTO relembra_fixture.events VALUES (8, 'retract', 'm-summary', 'fixture/a', '{"format":1,"kind":"retract","memoryId":"m-summary","scope":"fixture/a","principalId":"fixture-owner"}');
INSERT INTO relembra_fixture.events VALUES (9, 'note', 'm-other', 'fixture/b', '{"format":1,"kind":"note","memoryId":"m-other","scope":"fixture/b","principalId":"fixture-owner","pinned":false,"revision":{"number":1,"text":"Migrações do banco rodam à noite.","at":6000,"provenance":{"agent":"fixture-agent","harness":"fixture","model":"none","host":"fixture","trust":"owner","opId":"op-other"}}}');
INSERT INTO relembra_fixture.events VALUES (11, 'redact', 'm-gone', 'fixture/a', '{"format":1,"kind":"redact","memoryId":"m-gone","scope":"fixture/a","cause":"request","principalId":"fixture-owner"}');
INSERT INTO relembra_fixture.events VALUES (10, 'note', 'm-gone', 'fixture/a', '{"format":1,"kind":"note","memoryId":"m-gone","scope":"fixture/a","principalId":"fixture-owner","pinned":false,"redacted":true}');


--
-- Data for Name: fences; Type: TABLE DATA; Schema: relembra_fixture; Owner: -
--

INSERT INTO relembra_fixture.fences VALUES ('fixture-lease', 3);


--
-- Data for Name: import_checkpoints; Type: TABLE DATA; Schema: relembra_fixture; Owner: -
--

INSERT INTO relembra_fixture.import_checkpoints VALUES ('optmem:fixture', 96, 32);


--
-- Data for Name: memories; Type: TABLE DATA; Schema: relembra_fixture; Owner: -
--

INSERT INTO relembra_fixture.memories OVERRIDING SYSTEM VALUE VALUES (1, 'm-pinned', 'fixture/a', 1, true, 1793465184580, 1, 'Releases are cut on Thursdays.', 1000, '{"agent":"fixture-agent","harness":"fixture","model":"none","host":"fixture","trust":"owner","opId":"op-pinned"}', 'live', NULL, NULL);
INSERT INTO relembra_fixture.memories OVERRIDING SYSTEM VALUE VALUES (3, 'm-new', 'fixture/a', 3, false, 1793465184602, 1, 'Deploys run from the release branch.', 3000, '{"agent":"fixture-agent","harness":"fixture","model":"none","host":"fixture","trust":"agent","opId":"op-new"}', 'live', NULL, NULL);
INSERT INTO relembra_fixture.memories OVERRIDING SYSTEM VALUE VALUES (2, 'm-old', 'fixture/a', 2, false, 1793465184593, 1, 'Deploys run from the main branch.', 2000, '{"agent":"fixture-agent","harness":"fixture","model":"none","host":"fixture","trust":"owner","opId":"op-old"}', 'superseded', 'm-new', NULL);
INSERT INTO relembra_fixture.memories OVERRIDING SYSTEM VALUE VALUES (5, 'm-sourced', 'fixture/a', 5, false, 1793465184608, 1, 'The agent reviews each release.', 4000, '{"agent":"fixture-agent","harness":"fixture","model":"none","host":"fixture","trust":"owner","opId":"op-sourced"}', 'retracted', NULL, NULL);
INSERT INTO relembra_fixture.memories OVERRIDING SYSTEM VALUE VALUES (6, 'm-summary', 'fixture/a', 6, false, 1793465184614, 1, 'Summary: releases are reviewed.', 5000, '{"agent":"fixture-agent","harness":"fixture","model":"none","host":"fixture","trust":"agent","opId":"op-summary"}', 'retracted', NULL, '[{"memoryId":"m-sourced","revision":1}]');
INSERT INTO relembra_fixture.memories OVERRIDING SYSTEM VALUE VALUES (9, 'm-other', 'fixture/b', 9, false, 1793465184629, 1, 'Migrações do banco rodam à noite.', 6000, '{"agent":"fixture-agent","harness":"fixture","model":"none","host":"fixture","trust":"owner","opId":"op-other"}', 'live', NULL, NULL);


--
-- Data for Name: ops; Type: TABLE DATA; Schema: relembra_fixture; Owner: -
--

INSERT INTO relembra_fixture.ops VALUES ('fixture-owner', 'op-pinned', '18bd746a207b6de700e8310900721a96815910ff875ac7d514efe1c635f19409', 'm-pinned', 1793465184580, 1);
INSERT INTO relembra_fixture.ops VALUES ('fixture-owner', 'op-old', '604d5be64ff15bf251e1e2860cb3d5152a937d9068b96bec4f3f1eb17a5a6220', 'm-old', 1793465184593, 2);
INSERT INTO relembra_fixture.ops VALUES ('fixture-owner', 'op-new', 'a882725ee5b642587604f79e6e050e0e66700ad84b338cd3bb728bff20bea816', 'm-new', 1793465184602, 3);
INSERT INTO relembra_fixture.ops VALUES ('fixture-owner', 'op-sourced', '8af87480916a5e8973e6cfa5efe5a85605d16bcb3877e33aad3d2b7d65af3f58', 'm-sourced', 1793465184608, 5);
INSERT INTO relembra_fixture.ops VALUES ('fixture-owner', 'op-summary', '26323b680ae6fa2adbd0da8ac84afab6748a7fd000fb4d9dcc21b4f800a3e456', 'm-summary', 1793465184614, 6);
INSERT INTO relembra_fixture.ops VALUES ('fixture-owner', 'op-other', 'aa82cd7c519a43e6e87d67836e1389688d9e24c81946f4a7aec81a5a91715335', 'm-other', 1793465184629, 9);
INSERT INTO relembra_fixture.ops VALUES ('fixture-owner', 'op-gone', NULL, 'm-gone', 1793465184635, 10);


--
-- Data for Name: schema_version; Type: TABLE DATA; Schema: relembra_fixture; Owner: -
--

INSERT INTO relembra_fixture.schema_version VALUES (1, 1793465184570);


--
-- Data for Name: store_lock; Type: TABLE DATA; Schema: relembra_fixture; Owner: -
--

INSERT INTO relembra_fixture.store_lock VALUES (1);


--
-- Data for Name: term_docs; Type: TABLE DATA; Schema: relembra_fixture; Owner: -
--

INSERT INTO relembra_fixture.term_docs VALUES (1, 'm-pinned', 'fixture/a', 1, 5, 3);
INSERT INTO relembra_fixture.term_docs VALUES (3, 'm-new', 'fixture/a', 3, 6, 4);
INSERT INTO relembra_fixture.term_docs VALUES (9, 'm-other', 'fixture/b', 9, 5, 4);


--
-- Data for Name: term_postings; Type: TABLE DATA; Schema: relembra_fixture; Owner: -
--

INSERT INTO relembra_fixture.term_postings VALUES ('fixture/a', 0, 'releases', 1, 1, 1);
INSERT INTO relembra_fixture.term_postings VALUES ('fixture/a', 0, 'are', 1, 1, 0);
INSERT INTO relembra_fixture.term_postings VALUES ('fixture/a', 0, 'cut', 1, 1, 1);
INSERT INTO relembra_fixture.term_postings VALUES ('fixture/a', 0, 'on', 1, 1, 0);
INSERT INTO relembra_fixture.term_postings VALUES ('fixture/a', 0, 'thursdays', 1, 1, 1);
INSERT INTO relembra_fixture.term_postings VALUES ('fixture/a', 1, 'releas', 1, 1, 1);
INSERT INTO relembra_fixture.term_postings VALUES ('fixture/a', 1, 'are', 1, 1, 0);
INSERT INTO relembra_fixture.term_postings VALUES ('fixture/a', 1, 'cut', 1, 1, 1);
INSERT INTO relembra_fixture.term_postings VALUES ('fixture/a', 1, 'on', 1, 1, 0);
INSERT INTO relembra_fixture.term_postings VALUES ('fixture/a', 1, 'thursday', 1, 1, 1);
INSERT INTO relembra_fixture.term_postings VALUES ('fixture/a', 0, 'deploys', 3, 1, 1);
INSERT INTO relembra_fixture.term_postings VALUES ('fixture/a', 0, 'run', 3, 1, 1);
INSERT INTO relembra_fixture.term_postings VALUES ('fixture/a', 0, 'from', 3, 1, 0);
INSERT INTO relembra_fixture.term_postings VALUES ('fixture/a', 0, 'the', 3, 1, 0);
INSERT INTO relembra_fixture.term_postings VALUES ('fixture/a', 0, 'release', 3, 1, 1);
INSERT INTO relembra_fixture.term_postings VALUES ('fixture/a', 0, 'branch', 3, 1, 1);
INSERT INTO relembra_fixture.term_postings VALUES ('fixture/a', 1, 'deploy', 3, 1, 1);
INSERT INTO relembra_fixture.term_postings VALUES ('fixture/a', 1, 'run', 3, 1, 1);
INSERT INTO relembra_fixture.term_postings VALUES ('fixture/a', 1, 'from', 3, 1, 0);
INSERT INTO relembra_fixture.term_postings VALUES ('fixture/a', 1, 'the', 3, 1, 0);
INSERT INTO relembra_fixture.term_postings VALUES ('fixture/a', 1, 'release', 3, 1, 1);
INSERT INTO relembra_fixture.term_postings VALUES ('fixture/a', 1, 'branch', 3, 1, 1);
INSERT INTO relembra_fixture.term_postings VALUES ('fixture/b', 0, 'migracoes', 9, 1, 1);
INSERT INTO relembra_fixture.term_postings VALUES ('fixture/b', 0, 'do', 9, 1, 0);
INSERT INTO relembra_fixture.term_postings VALUES ('fixture/b', 0, 'banco', 9, 1, 1);
INSERT INTO relembra_fixture.term_postings VALUES ('fixture/b', 0, 'rodam', 9, 1, 1);
INSERT INTO relembra_fixture.term_postings VALUES ('fixture/b', 0, 'noite', 9, 1, 1);
INSERT INTO relembra_fixture.term_postings VALUES ('fixture/b', 1, 'migracao', 9, 1, 1);
INSERT INTO relembra_fixture.term_postings VALUES ('fixture/b', 1, 'do', 9, 1, 0);
INSERT INTO relembra_fixture.term_postings VALUES ('fixture/b', 1, 'banco', 9, 1, 1);
INSERT INTO relembra_fixture.term_postings VALUES ('fixture/b', 1, 'rodam', 9, 1, 1);
INSERT INTO relembra_fixture.term_postings VALUES ('fixture/b', 1, 'noite', 9, 1, 1);


--
-- Data for Name: term_scopes; Type: TABLE DATA; Schema: relembra_fixture; Owner: -
--

INSERT INTO relembra_fixture.term_scopes VALUES ('fixture/b', 1, 5, 4);
INSERT INTO relembra_fixture.term_scopes VALUES ('fixture/a', 2, 11, 7);


--
-- Data for Name: tombstones; Type: TABLE DATA; Schema: relembra_fixture; Owner: -
--

INSERT INTO relembra_fixture.tombstones VALUES ('m-gone', 'fixture/a', 11);


--
-- Name: memories_position_seq; Type: SEQUENCE SET; Schema: relembra_fixture; Owner: -
--

SELECT pg_catalog.setval('relembra_fixture.memories_position_seq', 10, true);


--
-- Name: erasure_outbox erasure_outbox_pkey; Type: CONSTRAINT; Schema: relembra_fixture; Owner: -
--

ALTER TABLE ONLY relembra_fixture.erasure_outbox
    ADD CONSTRAINT erasure_outbox_pkey PRIMARY KEY (seq);


--
-- Name: events events_pkey; Type: CONSTRAINT; Schema: relembra_fixture; Owner: -
--

ALTER TABLE ONLY relembra_fixture.events
    ADD CONSTRAINT events_pkey PRIMARY KEY (seq);


--
-- Name: fences fences_pkey; Type: CONSTRAINT; Schema: relembra_fixture; Owner: -
--

ALTER TABLE ONLY relembra_fixture.fences
    ADD CONSTRAINT fences_pkey PRIMARY KEY (key);


--
-- Name: import_checkpoints import_checkpoints_pkey; Type: CONSTRAINT; Schema: relembra_fixture; Owner: -
--

ALTER TABLE ONLY relembra_fixture.import_checkpoints
    ADD CONSTRAINT import_checkpoints_pkey PRIMARY KEY (source);


--
-- Name: memories memories_id_key; Type: CONSTRAINT; Schema: relembra_fixture; Owner: -
--

ALTER TABLE ONLY relembra_fixture.memories
    ADD CONSTRAINT memories_id_key UNIQUE (id);


--
-- Name: memories memories_pkey; Type: CONSTRAINT; Schema: relembra_fixture; Owner: -
--

ALTER TABLE ONLY relembra_fixture.memories
    ADD CONSTRAINT memories_pkey PRIMARY KEY ("position");


--
-- Name: ops ops_pkey; Type: CONSTRAINT; Schema: relembra_fixture; Owner: -
--

ALTER TABLE ONLY relembra_fixture.ops
    ADD CONSTRAINT ops_pkey PRIMARY KEY (principal_id, op_id);


--
-- Name: schema_version schema_version_pkey; Type: CONSTRAINT; Schema: relembra_fixture; Owner: -
--

ALTER TABLE ONLY relembra_fixture.schema_version
    ADD CONSTRAINT schema_version_pkey PRIMARY KEY (version);


--
-- Name: store_lock store_lock_pkey; Type: CONSTRAINT; Schema: relembra_fixture; Owner: -
--

ALTER TABLE ONLY relembra_fixture.store_lock
    ADD CONSTRAINT store_lock_pkey PRIMARY KEY (id);


--
-- Name: term_docs term_docs_pkey; Type: CONSTRAINT; Schema: relembra_fixture; Owner: -
--

ALTER TABLE ONLY relembra_fixture.term_docs
    ADD CONSTRAINT term_docs_pkey PRIMARY KEY ("position");


--
-- Name: term_postings term_postings_pkey; Type: CONSTRAINT; Schema: relembra_fixture; Owner: -
--

ALTER TABLE ONLY relembra_fixture.term_postings
    ADD CONSTRAINT term_postings_pkey PRIMARY KEY (scope, form, term, "position");


--
-- Name: term_scopes term_scopes_pkey; Type: CONSTRAINT; Schema: relembra_fixture; Owner: -
--

ALTER TABLE ONLY relembra_fixture.term_scopes
    ADD CONSTRAINT term_scopes_pkey PRIMARY KEY (scope);


--
-- Name: tombstones tombstones_pkey; Type: CONSTRAINT; Schema: relembra_fixture; Owner: -
--

ALTER TABLE ONLY relembra_fixture.tombstones
    ADD CONSTRAINT tombstones_pkey PRIMARY KEY (id);


--
-- Name: events_by_memory; Type: INDEX; Schema: relembra_fixture; Owner: -
--

CREATE INDEX events_by_memory ON relembra_fixture.events USING btree (memory_id);


--
-- Name: events_by_scope; Type: INDEX; Schema: relembra_fixture; Owner: -
--

CREATE INDEX events_by_scope ON relembra_fixture.events USING btree (scope, seq);


--
-- Name: memories_by_scope; Type: INDEX; Schema: relembra_fixture; Owner: -
--

CREATE INDEX memories_by_scope ON relembra_fixture.memories USING btree (scope, "position");


--
-- Name: ops_by_memory; Type: INDEX; Schema: relembra_fixture; Owner: -
--

CREATE INDEX ops_by_memory ON relembra_fixture.ops USING btree (memory_id);


--
-- Name: term_postings_by_position; Type: INDEX; Schema: relembra_fixture; Owner: -
--

CREATE INDEX term_postings_by_position ON relembra_fixture.term_postings USING btree ("position");


--
-- PostgreSQL database dump complete
--


