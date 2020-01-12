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
                            edges {
                                node {
                                    kind
                                    instances {
                                        edges {
                                            node {
                                                locations {
                                                    file {
                                                        path
                                                    }
                                                }
                                            }
                                        }
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

Invoke-RestMethod -Body $body |
    ForEach-Object { $_.data.repositories.edges } |
    ForEach-Object { $_.node.codeSmellLifespans.edges } |
    ForEach-Object { $_.node.instances.edges } |
    ForEach-Object {
        # Calculate pairwise distances
        $_.node.locations
    }
