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
progress_exam text;
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
from jsonb_each(coalesce(next_data->'userProgress', '{}'::jsonb)) loop
progress_subject := coalesce(progress_entry.value->>'subject', 'Unspecified');
progress_exam := case
    when progress_entry.value->>'exam' = 'CONSTABLE' then 'CONSTABLE'
    when progress_entry.value->>'exam' = 'SI' then 'SI'
    when next_data->>'exam' = 'CONSTABLE' then 'CONSTABLE'
    else 'SI'
end;
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
        progress_exam,
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