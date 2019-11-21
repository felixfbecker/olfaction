CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE code_smells (
    id uuid DEFAULT uuid_generate_v4() PRIMARY KEY,
    kind text NOT NULL,
    "message" text NOT NULL,
    predecessor uuid REFERENCES code_smells(id),
    repository text NOT NULL,
    commit_sha character(40) NOT NULL CHECK (commit_sha ~ '^[a-f0-9]{40}$')
);
CREATE UNIQUE INDEX code_smells_pkey ON code_smells(id uuid_ops);
