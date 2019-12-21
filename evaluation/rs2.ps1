# 2. How scattered are code smells in each commit over time?

param(
)

$body = (@{
    query = '
        {
            repositories {
                edges {
                    node {
                        codeSmellLifespans {
                            kind
                            instances {
                                locations {
                                    file {
                                        path
                                        distance(to: "???") # average, maximum, median, or something else to all other locations of the code smell or the code smell kind?
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    '
    variables = @{ }
} | ConvertTo-Json)

Invoke-RestMethod -Body $body
