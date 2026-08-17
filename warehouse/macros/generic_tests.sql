{#
    Generic tests, written here rather than pulled from dbt_utils so the project
    has no package dependencies and the assertions are readable in one place.
#}

{% test unique_combination(model, columns) %}
select {{ columns | join(', ') }}, count(*) as n
from {{ model }}
group by {{ columns | join(', ') }}
having count(*) > 1
{% endtest %}


{% test in_range(model, column_name, min_value, max_value) %}
select {{ column_name }}
from {{ model }}
where {{ column_name }} is not null
  and ({{ column_name }} < {{ min_value }} or {{ column_name }} > {{ max_value }})
{% endtest %}


{% test positive(model, column_name) %}
select {{ column_name }}
from {{ model }}
where {{ column_name }} is not null and {{ column_name }} <= 0
{% endtest %}
