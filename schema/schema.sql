--
-- PostgreSQL database dump
--

-- Dumped from database version 12.1
-- Dumped by pg_dump version 12.1

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: uuid-ossp; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA public;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: analyses; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.analyses (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    name text NOT NULL
);


--
-- Name: analyzed_commits; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.analyzed_commits (
    analysis uuid NOT NULL,
    repository text NOT NULL,
    commit text NOT NULL
);


--
-- Name: code_smell_lifespans; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.code_smell_lifespans (
    kind text NOT NULL,
    repository text NOT NULL,
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    analysis uuid NOT NULL
);


--
-- Name: code_smells; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.code_smells (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    message text,
    commit text NOT NULL,
    locations jsonb,
    lifespan uuid NOT NULL,
    ordinal integer NOT NULL,
    CONSTRAINT code_smells_locations_check CHECK (((jsonb_typeof(locations) = 'array'::text) AND (jsonb_array_length(locations) <> 0)))
);


--
-- Name: analyzed_commits analysed_revisions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analyzed_commits
    ADD CONSTRAINT analysed_revisions_pkey PRIMARY KEY (analysis, repository, commit);


--
-- Name: analyses analyses_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analyses
    ADD CONSTRAINT analyses_name_key UNIQUE (name);


--
-- Name: analyses analyses_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analyses
    ADD CONSTRAINT analyses_pkey PRIMARY KEY (id);


--
-- Name: code_smell_lifespans code_smell_lifespans_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.code_smell_lifespans
    ADD CONSTRAINT code_smell_lifespans_pkey PRIMARY KEY (id);


--
-- Name: code_smells code_smells_lifespan_lifespan_index_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.code_smells
    ADD CONSTRAINT code_smells_lifespan_lifespan_index_key UNIQUE (lifespan, ordinal);


--
-- Name: code_smells code_smells_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.code_smells
    ADD CONSTRAINT code_smells_pkey PRIMARY KEY (id);


--
-- Name: analysed_revisions_analysis_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX analysed_revisions_analysis_idx ON public.analyzed_commits USING btree (analysis);


--
-- Name: code_smell_lifespans_analysis_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX code_smell_lifespans_analysis_idx ON public.code_smell_lifespans USING btree (analysis);


--
-- Name: code_smell_lifespans_kind_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX code_smell_lifespans_kind_idx ON public.code_smell_lifespans USING btree (kind);


--
-- Name: code_smell_lifespans_repository_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX code_smell_lifespans_repository_idx ON public.code_smell_lifespans USING btree (repository);


--
-- Name: code_smells_commit_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX code_smells_commit_idx ON public.code_smells USING btree (commit);


--
-- Name: code_smells_lifespan_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX code_smells_lifespan_idx ON public.code_smells USING btree (lifespan);


--
-- Name: code_smells_lifespan_ordinal_locations_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX code_smells_lifespan_ordinal_locations_idx ON public.code_smells USING btree (lifespan, ordinal, locations);


--
-- Name: code_smells_locations_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX code_smells_locations_idx ON public.code_smells USING gin (locations);


--
-- Name: analyzed_commits analysed_revisions_analysis_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.analyzed_commits
    ADD CONSTRAINT analysed_revisions_analysis_fkey FOREIGN KEY (analysis) REFERENCES public.analyses(id) ON DELETE CASCADE;


--
-- Name: code_smell_lifespans code_smell_lifespans_analysis_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.code_smell_lifespans
    ADD CONSTRAINT code_smell_lifespans_analysis_fkey FOREIGN KEY (analysis) REFERENCES public.analyses(id) ON DELETE CASCADE;


--
-- Name: code_smells code_smells_lifespan_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.code_smells
    ADD CONSTRAINT code_smells_lifespan_fkey FOREIGN KEY (lifespan) REFERENCES public.code_smell_lifespans(id) ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--

