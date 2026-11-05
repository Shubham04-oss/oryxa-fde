-- A project thread can carry a question for the customer (#21): the customer room lists it, as its
-- text and when it was asked, until an FDE clears it or promotes the thread to a decision. The
-- question is written for the customer; the thread's comments never reach the room.
alter table threads
    add column customer_question text check (customer_question is null or length(customer_question) between 1 and 200),
    add column asked_at timestamptz,
    add check ((customer_question is null) = (asked_at is null)),
    add check (customer_question is null or (project_id is not null and decision_id is null));

grant update (customer_question, asked_at) on threads to oryxa_fde_app;
