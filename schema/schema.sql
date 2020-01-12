CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE code_smells (
    id uuid DEFAULT uuid_generate_v4() PRIMARY KEY,
    "message" text,
    "commit" text,
    locations jsonb,
    lifespan uuid NOT NULL REFERENCES code_smell_lifespans(id),
    ordinal integer NOT NULL
);

CREATE UNIQUE INDEX code_smells_pkey ON code_smells(id uuid_ops);

CREATE TABLE code_smell_lifespans (
    kind text NOT NULL,
    repository text NOT NULL,
    id uuid DEFAULT uuid_generate_v4() PRIMARY KEY
);

CREATE UNIQUE INDEX code_smell_lifespans_pkey ON code_smell_lifespans(id uuid_ops);
