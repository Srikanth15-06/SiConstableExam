create table if not exists public.topic_learning_videos (
    id uuid primary key default gen_random_uuid(),
    exam_type text not null check (exam_type in ('SI', 'CONSTABLE')),
    subject text not null,
    topic text not null,
    title text not null check (char_length(trim(title)) between 1 and 120),
    youtube_url text not null,
    youtube_video_id text not null check (youtube_video_id ~ '^[A-Za-z0-9_-]{11}$'),
    display_order smallint not null check (display_order between 1 and 5),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    check (youtube_url = 'https://www.youtube.com/watch?v=' || youtube_video_id),
    unique (exam_type, subject, topic, display_order)
);

create index if not exists topic_learning_videos_topic_order_idx
    on public.topic_learning_videos (exam_type, subject, topic, display_order);

create or replace function public.assign_topic_learning_video_order()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
    next_order smallint;
begin
    perform pg_advisory_xact_lock(hashtextextended(new.exam_type || ':' || new.subject || ':' || new.topic, 0));

    select candidate_order
    into next_order
    from generate_series(1, 5) as candidate_orders(candidate_order)
    where not exists (
        select 1
        from public.topic_learning_videos as existing
        where existing.exam_type = new.exam_type
            and existing.subject = new.subject
            and existing.topic = new.topic
            and existing.display_order = candidate_order
    )
    order by candidate_order
    limit 1;

    if next_order is null then
        raise exception using errcode = '23514', message = 'maximum topic learning video count reached';
    end if;

    new.display_order := next_order;
    return new;
end;
$$;

create trigger topic_learning_videos_assign_order
before insert on public.topic_learning_videos
for each row execute function public.assign_topic_learning_video_order();

alter table public.topic_learning_videos enable row level security;
revoke all on public.topic_learning_videos from public, anon, authenticated;
grant select, insert, update, delete on public.topic_learning_videos to service_role;
revoke all on function public.assign_topic_learning_video_order() from public, anon, authenticated;