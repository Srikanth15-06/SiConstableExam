create table if not exists public.app_users (
    id text primary key check (id ~ '^usr_[a-f0-9-]{36}$'),
    username text not null check (
        char_length(username) between 1 and 120
    ),
    email text not null,
    password_hash text not null,
    status text not null default 'active' check (status in ('active', 'disabled')),
    exam_type text not null default 'SI' check (exam_type in ('SI', 'CONSTABLE')),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    last_login_at timestamptz
);
create unique index if not exists app_users_email_lower_unique on public.app_users (lower(email));
create table if not exists public.app_sessions (
    id uuid primary key default gen_random_uuid(),
    user_id text not null references public.app_users(id) on delete cascade,
    token_hash text not null unique check (token_hash ~ '^[a-f0-9]{64}$'),
    expires_at timestamptz not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);
create index if not exists app_sessions_user_expiry_idx on public.app_sessions (user_id, expires_at);
create index if not exists app_sessions_expiry_idx on public.app_sessions (expires_at);
create table if not exists public.app_user_state (
    user_id text primary key references public.app_users(id) on delete cascade,
    revision bigint not null default 0 check (revision >= 0),
    data jsonb not null check (jsonb_typeof(data) = 'object'),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);
create table if not exists public.user_progress (
    user_id text not null references public.app_users(id) on delete cascade,
    exam_type text not null check (exam_type in ('SI', 'CONSTABLE')),
    subject text not null,
    topic text not null,
    attempts integer not null default 0 check (attempts >= 0),
    correct_answers integer not null default 0 check (correct_answers >= 0),
    total_questions integer not null default 0 check (total_questions >= correct_answers),
    accuracy numeric(5, 2) not null default 0 check (
        accuracy between 0 and 100
    ),
    progress_data jsonb not null default '{}'::jsonb check (jsonb_typeof(progress_data) = 'object'),
    updated_at timestamptz not null default now(),
    primary key (user_id, exam_type, subject, topic)
);
create index if not exists user_progress_user_exam_idx on public.user_progress (user_id, exam_type);
create table if not exists public.quiz_attempts (
    user_id text not null references public.app_users(id) on delete cascade,
    attempt_id text not null,
    idempotency_key text,
    exam text not null check (exam in ('SI', 'CONSTABLE')),
    subject text not null,
    topic text not null,
    level text not null,
    status text not null check (status in ('in_progress', 'submitted')),
    score integer not null default 0 check (score >= 0),
    total_questions integer not null default 10 check (total_questions > 0),
    accuracy numeric(5, 2) not null default 0 check (
        accuracy between 0 and 100
    ),
    started_at timestamptz not null,
    submitted_at timestamptz,
    attempt_data jsonb not null check (jsonb_typeof(attempt_data) = 'object'),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    primary key (user_id, attempt_id),
    check (score <= total_questions)
);
create unique index if not exists quiz_attempts_idempotency_unique on public.quiz_attempts (user_id, idempotency_key)
where idempotency_key is not null;
create index if not exists quiz_attempts_user_submitted_idx on public.quiz_attempts (user_id, submitted_at desc);
create index if not exists quiz_attempts_user_context_idx on public.quiz_attempts (user_id, exam, subject, topic);
create table if not exists public.planner_documents (
    user_id text primary key references public.app_users(id) on delete cascade,
    revision bigint not null default 0 check (revision >= 0),
    planner_data jsonb not null default '{"examType":"SI","generatedAt":null,"summary":{},"topicMetrics":[],"schedule":[]}'::jsonb check (jsonb_typeof(planner_data) = 'object'),
    updated_at timestamptz not null default now()
);
create table if not exists public.user_history (
    user_id text not null references public.app_users(id) on delete cascade,
    attempt_id text not null,
    exam text not null check (exam in ('SI', 'CONSTABLE')),
    subject text not null,
    topic text not null,
    content jsonb not null check (jsonb_typeof(content) = 'object'),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    primary key (user_id, attempt_id)
);
create index if not exists user_history_user_created_idx on public.user_history (user_id, created_at desc);
create table if not exists public.user_notes (
    id uuid primary key default gen_random_uuid(),
    user_id text references public.app_users(id) on delete cascade,
    exam text check (
        exam is null
        or exam in ('SI', 'CONSTABLE')
    ),
    subject text,
    topic text,
    content jsonb not null default '{}'::jsonb check (jsonb_typeof(content) = 'object'),
    metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);
create index if not exists user_notes_user_topic_idx on public.user_notes (user_id, exam, subject, topic);
create table if not exists public.drive_oauth_tokens (
    provider text primary key check (provider = 'google-drive'),
    encrypted_payload jsonb not null check (jsonb_typeof(encrypted_payload) = 'object'),
    updated_at timestamptz not null default now()
);
alter table public.app_users enable row level security;
alter table public.app_sessions enable row level security;
alter table public.app_user_state enable row level security;
alter table public.user_progress enable row level security;
alter table public.quiz_attempts enable row level security;
alter table public.planner_documents enable row level security;
alter table public.user_history enable row level security;
alter table public.user_notes enable row level security;
alter table public.drive_oauth_tokens enable row level security;
revoke all on public.app_users,
public.app_sessions,
public.app_user_state,
public.user_progress,
public.quiz_attempts,
public.planner_documents,
public.user_history,
public.user_notes,
public.drive_oauth_tokens
from anon,
    authenticated;
grant all on public.app_users,
    public.app_sessions,
    public.app_user_state,
    public.user_progress,
    public.quiz_attempts,
    public.planner_documents,
    public.user_history,
    public.user_notes,
    public.drive_oauth_tokens to service_role;
grant usage,
    select on all sequences in schema public to service_role;
create or replace function public.create_app_account(
        p_user_id text,
        p_username text,
        p_email text,
        p_password_hash text,
        p_status text,
        p_created_at timestamptz,
        p_user_data jsonb
    ) returns jsonb language plpgsql security definer
set search_path = public,
    pg_temp as $$
declare created_user public.app_users %rowtype;
normalized_email text := lower(trim(p_email));
begin if p_user_id !~ '^usr_[a-f0-9-]{36}$'
or jsonb_typeof(p_user_data) <> 'object'
    or coalesce(p_user_data->>'userId', '') <> p_user_id
    or p_status not in ('active', 'disabled')
or p_password_hash !~ '^\$2[aby]\$[0-9]{2}\$' then raise exception using errcode = '22023',
message = 'invalid account input';
end if;
insert into public.app_users (
        id,
        username,
        email,
        password_hash,
        status,
        exam_type,
        created_at,
        updated_at
    )
values (
        p_user_id,
        trim(p_username),
        normalized_email,
        p_password_hash,
        p_status,
        'SI',
        p_created_at,
        p_created_at
    )
returning * into created_user;
insert into public.app_user_state (user_id, revision, data)
values (
        p_user_id,
        0,
        jsonb_set(p_user_data, '{revision}', '0'::jsonb, true)
    );
insert into public.planner_documents (user_id, revision, planner_data)
values (
        p_user_id,
        0,
        coalesce(p_user_data->'plannerData', '{}'::jsonb)
    );
return to_jsonb(created_user);
exception
when unique_violation then raise exception using errcode = '23505',
message = 'account already exists';
end;
$$;
create or replace function public.record_app_login(p_user_id text, p_logged_in_at timestamptz) returns jsonb language plpgsql security definer
set search_path = public,
    pg_temp as $$
declare changed_user public.app_users %rowtype;
begin
update public.app_users
set last_login_at = p_logged_in_at,
    updated_at = p_logged_in_at
where id = p_user_id
    and status = 'active'
returning * into changed_user;
if not found then raise exception using errcode = 'P0002',
message = 'account not found';
end if;
return to_jsonb(changed_user);
end;
$$;
create or replace function public.update_app_profile(
        p_user_id text,
        p_username text,
        p_exam text,
        p_updated_at timestamptz
    ) returns jsonb language plpgsql security definer
set search_path = public,
    pg_temp as $$
declare changed_user public.app_users %rowtype;
begin if p_exam not in ('SI', 'CONSTABLE')
or char_length(trim(p_username)) not between 1 and 120 then raise exception using errcode = '22023',
message = 'invalid profile';
end if;
update public.app_users
set username = trim(p_username),
    exam_type = p_exam,
    updated_at = p_updated_at
where id = p_user_id
    and status = 'active'
returning * into changed_user;
if not found then raise exception using errcode = 'P0002',
message = 'account not found';
end if;
update public.app_user_state
set revision = revision + 1,
    data = jsonb_set(
        jsonb_set(
            jsonb_set(
                jsonb_set(data, '{profile,name}', to_jsonb(trim(p_username)), true),
                '{exam}', to_jsonb(p_exam), true
            ),
            '{plannerData,examType}', to_jsonb(p_exam), true
        ),
        '{revision}', to_jsonb(revision + 1), true
    ),
    updated_at = p_updated_at
where user_id = p_user_id;
update public.planner_documents
set planner_data = jsonb_set(
        planner_data,
        '{examType}',
        to_jsonb(p_exam),
        true
    ),
    updated_at = p_updated_at
where user_id = p_user_id;
return to_jsonb(changed_user);
end;
$$;
create or replace function public.commit_app_user_state(
        p_user_id text,
        p_expected_revision bigint,
        p_data jsonb
    ) returns jsonb language plpgsql security definer
set search_path = public,
    pg_temp as $$
declare current_revision bigint;
next_revision bigint;
next_data jsonb;
progress_entry record;
attempt_entry jsonb;
history_entry jsonb;
progress_subject text;
correct_count integer;
question_count integer;
begin if jsonb_typeof(p_data) <> 'object'
or p_data->>'userId' <> p_user_id then raise exception using errcode = '22023',
message = 'invalid user state';
end if;
select revision into current_revision
from public.app_user_state
where user_id = p_user_id for
update;
if not found then raise exception using errcode = 'P0002',
message = 'user state not found';
end if;
if current_revision <> p_expected_revision then raise exception using errcode = '40001',
message = 'user state revision conflict';
end if;
next_revision := current_revision + 1;
next_data := jsonb_set(
    p_data,
    '{revision}',
    to_jsonb(next_revision),
    true
);
update public.app_user_state
set data = next_data,
    revision = next_revision,
    updated_at = now()
where user_id = p_user_id;
insert into public.planner_documents (user_id, revision, planner_data, updated_at)
values (
        p_user_id,
        coalesce((next_data->>'plannerRevision')::bigint, 0),
        coalesce(next_data->'plannerData', '{}'::jsonb),
        now()
    ) on conflict (user_id) do
update
set revision = excluded.revision,
    planner_data = excluded.planner_data,
    updated_at = excluded.updated_at;
delete from public.user_progress
where user_id = p_user_id;
for progress_entry in
select key,
    value
from jsonb_each(coalesce(next_data->'userProgress', '{}'::jsonb)) loop progress_subject := coalesce(progress_entry.value->>'subject', 'Unspecified');
correct_count := coalesce(
    nullif(progress_entry.value->>'correctAnswers', '')::integer,
    round(
        coalesce(
            nullif(progress_entry.value->>'accuracy', '')::numeric,
            0
        ) * coalesce(
            nullif(progress_entry.value->>'attempts', '')::integer,
            0
        ) * 10 / 100
    )::integer,
    0
);
question_count := coalesce(
    nullif(progress_entry.value->>'totalQuestions', '')::integer,
    coalesce(
        nullif(progress_entry.value->>'attempts', '')::integer,
        0
    ) * 10,
    0
);
insert into public.user_progress (
        user_id,
        exam_type,
        subject,
        topic,
        attempts,
        correct_answers,
        total_questions,
        accuracy,
        progress_data
    )
values (
        p_user_id,
        case
            when next_data->>'exam' = 'CONSTABLE' then 'CONSTABLE'
            else 'SI'
        end,
        progress_subject,
        coalesce(
            progress_entry.value->>'topic',
            progress_entry.key
        ),
        coalesce(
            nullif(progress_entry.value->>'attempts', '')::integer,
            0
        ),
        correct_count,
        greatest(question_count, correct_count),
        coalesce(
            nullif(progress_entry.value->>'accuracy', '')::numeric,
            0
        ),
        progress_entry.value
    );
end loop;
delete from public.quiz_attempts
where user_id = p_user_id;
for attempt_entry in
select value
from jsonb_array_elements(coalesce(next_data->'attempts', '[]'::jsonb)) loop
insert into public.quiz_attempts (
        user_id,
    attempt_id,
    idempotency_key,
    exam,
    subject,
        topic,
        level,
        status,
        score,
        total_questions,
        accuracy,
        started_at,
        submitted_at,
        attempt_data
    )
values (
        p_user_id,
        attempt_entry->>'attemptId',
        attempt_entry->>'idempotencyKey',
        case
            when attempt_entry->>'exam' = 'CONSTABLE' then 'CONSTABLE'
            else 'SI'
        end,
        coalesce(attempt_entry->>'subject', 'Unspecified'),
        coalesce(attempt_entry->>'topic', 'Unspecified'),
        coalesce(attempt_entry->>'difficulty', 'Beginner'),
        coalesce(attempt_entry->>'status', 'in_progress'),
        coalesce(
            nullif(attempt_entry#>>'{result,correct}', '')::integer,
            nullif(attempt_entry#>>'{result,score}', '')::integer,
            0
        ),
        greatest(
            coalesce(
                jsonb_array_length(attempt_entry->'questions'),
                10
            ),
            1
        ),
        coalesce(
            nullif(attempt_entry#>>'{result,accuracy}', '')::numeric,
            0
        ),
        coalesce(
            nullif(attempt_entry->>'startedAt', '')::timestamptz,
            now()
        ),
        nullif(attempt_entry->>'submittedAt', '')::timestamptz,
        attempt_entry
    );
end loop;
delete from public.user_history
where user_id = p_user_id;
for history_entry in
select value
from jsonb_array_elements(coalesce(next_data->'testHistory', '[]'::jsonb)) loop
insert into public.user_history (
        user_id,
        attempt_id,
        exam,
        subject,
        topic,
        content,
        created_at,
        updated_at
    )
values (
        p_user_id,
        coalesce(
            history_entry->>'attemptId',
            history_entry->>'id',
            gen_random_uuid()::text
        ),
        case
            when history_entry->>'exam' = 'CONSTABLE' then 'CONSTABLE'
            else 'SI'
        end,
        coalesce(history_entry->>'subject', 'Unspecified'),
        coalesce(history_entry->>'topic', 'Unspecified'),
        history_entry,
        coalesce(
            nullif(history_entry->>'submittedAt', '')::timestamptz,
            now()
        ),
        now()
    );
end loop;
return jsonb_build_object('revision', next_revision, 'data', next_data);
end;
$$;
create or replace function public.create_app_account_from_legacy(
        p_user_id text,
        p_username text,
        p_email text,
        p_password_hash text,
        p_created_at timestamptz,
        p_user_data jsonb
    ) returns jsonb language plpgsql security definer
set search_path = public,
    pg_temp as $$
declare created_user public.app_users %rowtype;
normalized_email text := lower(trim(p_email));
begin if coalesce(p_user_id, '') !~ '^usr_[a-f0-9-]{36}$'
or char_length(coalesce(trim(p_username), '')) not between 1 and 120
or coalesce(normalized_email, '') !~ '^\S+@\S+\.\S+$'
or coalesce(p_password_hash, '') !~ '^\$2[aby]\$[0-9]{2}\$'
or coalesce(jsonb_typeof(p_user_data), '') <> 'object'
or p_user_data->>'userId' is distinct from p_user_id
or coalesce(p_user_data->>'exam', '') not in ('SI', 'CONSTABLE')
or coalesce(jsonb_typeof(p_user_data->'legacyImport'), '') <> 'object'
or coalesce(p_user_data#>>'{legacyImport,version}', '') <> '1'
or coalesce(p_user_data#>>'{legacyImport,fingerprint}', '') !~ '^[a-f0-9]{64}$'
or p_user_data->'profile'->>'name' is distinct from trim(p_username)
or lower(coalesce(p_user_data->'profile'->>'email', '')) is distinct from normalized_email
or coalesce(jsonb_typeof(p_user_data->'legacyArchive'), '') <> 'object'
or coalesce(p_user_data->'userProgress', 'null'::jsonb) <> '{}'::jsonb
or coalesce(p_user_data->'testHistory', 'null'::jsonb) <> '[]'::jsonb
or coalesce(p_user_data->'attempts', 'null'::jsonb) <> '[]'::jsonb then raise exception using errcode = '22023',
message = 'invalid legacy account input';
end if;
insert into public.app_users (
        id,
        username,
        email,
        password_hash,
        status,
        exam_type,
        created_at,
        updated_at
    )
values (
        p_user_id,
        trim(p_username),
        normalized_email,
        p_password_hash,
        'active',
        p_user_data->>'exam',
        p_created_at,
        p_created_at
    )
returning * into created_user;
insert into public.app_user_state (user_id, revision, data, created_at, updated_at)
values (p_user_id, 0, p_user_data, p_created_at, p_created_at);
insert into public.planner_documents (user_id, revision, planner_data, updated_at)
values (
        p_user_id,
        coalesce((p_user_data->>'plannerRevision')::bigint, 0),
        coalesce(p_user_data->'plannerData', '{}'::jsonb),
        p_created_at
    );
return jsonb_build_object(
    'account', to_jsonb(created_user),
    'data', p_user_data,
    'idempotent', false
);
exception
when unique_violation then raise exception using errcode = '23505',
message = 'account already exists';
end;
$$;
create or replace function public.import_app_user_legacy_state(
        p_user_id text,
        p_expected_revision bigint,
        p_user_data jsonb
    ) returns jsonb language plpgsql security definer
set search_path = public,
    pg_temp as $$
declare current_revision bigint;
current_data jsonb;
next_data jsonb;
legacy_fingerprint text;
target_user public.app_users %rowtype;
state_exists boolean := false;
begin if coalesce(p_user_id, '') !~ '^usr_[a-f0-9-]{36}$'
or coalesce(jsonb_typeof(p_user_data), '') <> 'object'
or p_user_data->>'userId' is distinct from p_user_id
or coalesce(jsonb_typeof(p_user_data->'legacyImport'), '') <> 'object'
or coalesce(p_user_data#>>'{legacyImport,version}', '') <> '1'
or coalesce(p_user_data#>>'{legacyImport,fingerprint}', '') !~ '^[a-f0-9]{64}$'
or coalesce(p_user_data->'userProgress', 'null'::jsonb) <> '{}'::jsonb
or coalesce(p_user_data->'testHistory', 'null'::jsonb) <> '[]'::jsonb
or coalesce(p_user_data->'attempts', 'null'::jsonb) <> '[]'::jsonb then raise exception using errcode = '22023',
message = 'invalid legacy state input';
end if;
legacy_fingerprint := p_user_data#>>'{legacyImport,fingerprint}';
select * into target_user
from public.app_users
where id = p_user_id for
update;
if not found or target_user.status <> 'active' then raise exception using errcode = 'P0002',
message = 'account not found';
end if;
if lower(coalesce(p_user_data->'profile'->>'email', '')) is distinct from lower(target_user.email) then raise exception using errcode = '22023',
message = 'legacy account email mismatch';
end if;
select revision, data into current_revision, current_data
from public.app_user_state
where user_id = p_user_id for
update;
state_exists := found;
if state_exists then
    if current_data is null or jsonb_typeof(current_data) = 'null' then current_data := '{}'::jsonb;
    elsif jsonb_typeof(current_data) <> 'object' then raise exception using errcode = '40001',
    message = 'invalid existing user state';
    end if;
else
    current_revision := 0;
    current_data := '{}'::jsonb;
end if;
if current_data#>>'{legacyImport,fingerprint}' is not null then
    if current_data#>>'{legacyImport,fingerprint}' = legacy_fingerprint then
        return jsonb_build_object('revision', current_revision, 'data', current_data, 'idempotent', true);
    end if;
    raise exception using errcode = '23505',
    message = 'a different legacy import already exists';
end if;
if p_expected_revision is distinct from 0 or (state_exists and current_revision <> 0)
or (current_data ? 'userProgress' and jsonb_typeof(current_data->'userProgress') <> 'null' and current_data->'userProgress' <> '{}'::jsonb)
or (current_data ? 'testHistory' and jsonb_typeof(current_data->'testHistory') <> 'null' and current_data->'testHistory' <> '[]'::jsonb)
or (current_data ? 'attempts' and jsonb_typeof(current_data->'attempts') <> 'null' and current_data->'attempts' <> '[]'::jsonb)
or coalesce(current_data->>'seenQuestionCount', '0') not in ('0', '0.0')
or coalesce(current_data->>'testAttemptCounter', '0') not in ('0', '0.0')
or (current_data#>'{plannerData,schedule}' is not null and jsonb_typeof(current_data#>'{plannerData,schedule}') <> 'null' and current_data#>'{plannerData,schedule}' <> '[]'::jsonb)
or (current_data#>'{plannerData,topicMetrics}' is not null and jsonb_typeof(current_data#>'{plannerData,topicMetrics}') <> 'null' and current_data#>'{plannerData,topicMetrics}' <> '[]'::jsonb)
or (current_data#>'{plannerData,summary}' is not null and jsonb_typeof(current_data#>'{plannerData,summary}') <> 'null' and current_data#>'{plannerData,summary}' <> '{}'::jsonb)
or exists (select 1 from public.user_progress where user_id = p_user_id)
or exists (select 1 from public.quiz_attempts where user_id = p_user_id)
or exists (select 1 from public.user_history where user_id = p_user_id)
or exists (select 1 from public.user_notes where user_id = p_user_id)
or exists (
    select 1
    from public.planner_documents planner
    where planner.user_id = p_user_id
        and (
            planner.revision <> coalesce(current_data->>'plannerRevision', '0')::bigint
            or (planner.planner_data ? 'schedule' and planner.planner_data->'schedule' <> '[]'::jsonb)
            or (planner.planner_data ? 'topicMetrics' and planner.planner_data->'topicMetrics' <> '[]'::jsonb)
            or (planner.planner_data ? 'summary' and planner.planner_data->'summary' <> '{}'::jsonb)
        )
) then raise exception using errcode = '40001',
message = 'existing user data prevents legacy import';
end if;
next_data := jsonb_set(p_user_data, '{revision}', '1'::jsonb, true);
if state_exists then
update public.app_user_state
set revision = 1,
    data = next_data,
    updated_at = now()
where user_id = p_user_id;
else
    insert into public.app_user_state (user_id, revision, data, created_at, updated_at)
    values (p_user_id, 1, next_data, now(), now());
end if;
insert into public.planner_documents (user_id, revision, planner_data, updated_at)
values (
        p_user_id,
        coalesce((next_data->>'plannerRevision')::bigint, 0),
        coalesce(next_data->'plannerData', '{}'::jsonb),
        now()
    ) on conflict (user_id) do
update
set revision = excluded.revision,
    planner_data = excluded.planner_data,
    updated_at = excluded.updated_at;
return jsonb_build_object('revision', 1, 'data', next_data, 'idempotent', false);
end;
$$;
revoke all on function public.create_app_account(text, text, text, text, text, timestamptz, jsonb)
from public,
    anon,
    authenticated;
revoke all on function public.record_app_login(text, timestamptz)
from public,
    anon,
    authenticated;
revoke all on function public.update_app_profile(text, text, text, timestamptz)
from public,
    anon,
    authenticated;
revoke all on function public.commit_app_user_state(text, bigint, jsonb)
from public,
    anon,
    authenticated;
revoke all on function public.create_app_account_from_legacy(text, text, text, text, timestamptz, jsonb)
from public,
    anon,
    authenticated;
revoke all on function public.import_app_user_legacy_state(text, bigint, jsonb)
from public,
    anon,
    authenticated;
grant execute on function public.create_app_account(text, text, text, text, text, timestamptz, jsonb) to service_role;
grant execute on function public.record_app_login(text, timestamptz) to service_role;
grant execute on function public.update_app_profile(text, text, text, timestamptz) to service_role;
grant execute on function public.commit_app_user_state(text, bigint, jsonb) to service_role;
grant execute on function public.create_app_account_from_legacy(text, text, text, text, timestamptz, jsonb) to service_role;
grant execute on function public.import_app_user_legacy_state(text, bigint, jsonb) to service_role;